//! A drag to another program through OLE (Windows): an IDataObject offering the files as
//! CF_HDROP, an IDropSource whose decisions come from the drag engine, and DoDragDrop. Run on
//! the engine thread (drag/win.rs), which called OleInitialize and pumps messages: an STA.
//!
//! The COM objects are hand-written vtables over windows-sys (no `windows` crate): each object is
//! a #[repr(C)] struct whose first field is its vtable pointer, reference counted, freed on the
//! last Release. Only what targets ask for is implemented; the rest returns E_NOTIMPL /
//! OLE_E_ADVISENOTSUPPORTED as the documentation allows.

use std::cell::RefCell;
use std::ffi::c_void;
use std::path::PathBuf;
use std::ptr::null_mut;
use std::sync::atomic::{AtomicU32, Ordering};

use windows_sys::core::{GUID, HRESULT};
use windows_sys::Win32::System::Com::{FORMATETC, STGMEDIUM};
use windows_sys::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT};
use windows_sys::Win32::System::Ole::{DoDragDrop, OleInitialize};

use super::transfer::{hdrop_bytes, png_to_dibv5, DROPEFFECT_COPY};

const S_OK: HRESULT = 0;
const S_FALSE: HRESULT = 1;
const E_NOTIMPL: HRESULT = 0x8000_4001_u32 as i32;
const E_NOINTERFACE: HRESULT = 0x8000_4002_u32 as i32;
const E_POINTER: HRESULT = 0x8000_4003_u32 as i32;
const E_OUTOFMEMORY: HRESULT = 0x8007_000E_u32 as i32;
const DV_E_FORMATETC: HRESULT = 0x8004_0064_u32 as i32;
const OLE_E_ADVISENOTSUPPORTED: HRESULT = 0x8004_0003_u32 as i32;
const DATA_S_SAMEFORMATETC: HRESULT = 0x0004_0130;
pub const DRAGDROP_S_DROP: HRESULT = 0x0004_0100;
pub const DRAGDROP_S_CANCEL: HRESULT = 0x0004_0101;
const DRAGDROP_S_USEDEFAULTCURSORS: HRESULT = 0x0004_0102;

const CF_HDROP: u16 = 15;
const CF_DIBV5: u16 = 17;
const TYMED_HGLOBAL: u32 = 1;
const DVASPECT_CONTENT: u32 = 1;

const fn guid(d1: u32, d2: u16, d3: u16, d4: [u8; 8]) -> GUID {
    GUID { data1: d1, data2: d2, data3: d3, data4: d4 }
}
const COM_TAIL: [u8; 8] = [0xC0, 0, 0, 0, 0, 0, 0, 0x46];
const IID_IUNKNOWN: GUID = guid(0x0000_0000, 0, 0, COM_TAIL);
const IID_IDATAOBJECT: GUID = guid(0x0000_010E, 0, 0, COM_TAIL);
const IID_IDROPSOURCE: GUID = guid(0x0000_0121, 0, 0, COM_TAIL);
const IID_IENUMFORMATETC: GUID = guid(0x0000_0103, 0, 0, COM_TAIL);

fn same(a: &GUID, b: &GUID) -> bool {
    a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
}

fn format(cf: u16) -> FORMATETC {
    FORMATETC { cfFormat: cf, ptd: null_mut(), dwAspect: DVASPECT_CONTENT, lindex: -1, tymed: TYMED_HGLOBAL }
}

/// The registered "PNG" clipboard format (image data with transparency).
fn png_format_id() -> u16 {
    let name: Vec<u16> = "PNG".encode_utf16().chain(Some(0)).collect();
    unsafe { RegisterClipboardFormatW(name.as_ptr()) as u16 }
}

/// What a drag offers, most preferred first: the files always; for one layer also its image as
/// PNG data and as a DIBV5 bitmap, for programs that take pictures but not files.
pub fn offered_formats(files: usize, png_cf: u16) -> Vec<u16> {
    if files == 1 && png_cf != 0 { vec![CF_HDROP, png_cf, CF_DIBV5] } else { vec![CF_HDROP] }
}

/// An HGLOBAL holding `bytes` (the receiver owns and frees it).
unsafe fn global_from(bytes: &[u8]) -> Option<*mut c_void> {
    let h = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len().max(1));
    if h.is_null() {
        return None;
    }
    let p = GlobalLock(h) as *mut u8;
    if p.is_null() {
        return None;
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
    GlobalUnlock(h);
    Some(h)
}

// ── IDataObject ──

#[repr(C)]
struct DataObjectVtbl {
    query_interface: unsafe extern "system" fn(*mut DataObject, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut DataObject) -> u32,
    release: unsafe extern "system" fn(*mut DataObject) -> u32,
    get_data: unsafe extern "system" fn(*mut DataObject, *const FORMATETC, *mut STGMEDIUM) -> HRESULT,
    get_data_here: unsafe extern "system" fn(*mut DataObject, *const FORMATETC, *mut STGMEDIUM) -> HRESULT,
    query_get_data: unsafe extern "system" fn(*mut DataObject, *const FORMATETC) -> HRESULT,
    get_canonical_format_etc: unsafe extern "system" fn(*mut DataObject, *const FORMATETC, *mut FORMATETC) -> HRESULT,
    set_data: unsafe extern "system" fn(*mut DataObject, *const FORMATETC, *const STGMEDIUM, i32) -> HRESULT,
    enum_format_etc: unsafe extern "system" fn(*mut DataObject, u32, *mut *mut c_void) -> HRESULT,
    d_advise: unsafe extern "system" fn(*mut DataObject, *const FORMATETC, u32, *mut c_void, *mut u32) -> HRESULT,
    d_unadvise: unsafe extern "system" fn(*mut DataObject, u32) -> HRESULT,
    enum_d_advise: unsafe extern "system" fn(*mut DataObject, *mut *mut c_void) -> HRESULT,
}

#[repr(C)]
struct DataObject {
    vtbl: *const DataObjectVtbl,
    refs: AtomicU32,
    hdrop: Vec<u8>,
    formats: Vec<FORMATETC>,
    png_cf: u16,
    /// the single layer's file, for the image formats
    image: Option<PathBuf>,
    /// PNG bytes and the DIBV5 made from them: read / converted on the first request only
    png: RefCell<Option<Option<Vec<u8>>>>,
    dib: RefCell<Option<Option<Vec<u8>>>>,
}

impl DataObject {
    fn offers(&self, f: &FORMATETC) -> bool {
        f.tymed & TYMED_HGLOBAL != 0 && f.dwAspect == DVASPECT_CONTENT && self.formats.iter().any(|o| o.cfFormat == f.cfFormat)
    }

    fn png_bytes(&self) -> Option<Vec<u8>> {
        self.png
            .borrow_mut()
            .get_or_insert_with(|| self.image.as_ref().and_then(|p| std::fs::read(p).ok()))
            .clone()
    }

    fn dib_bytes(&self) -> Option<Vec<u8>> {
        if let Some(d) = self.dib.borrow().as_ref() {
            return d.clone();
        }
        let d = self.png_bytes().and_then(|png| match png_to_dibv5(&png) {
            Ok(d) => Some(d),
            Err(e) => {
                crate::log::line(format!("ole DIBV5 not made: {e}"));
                None
            }
        });
        *self.dib.borrow_mut() = Some(d.clone());
        d
    }
}

unsafe extern "system" fn do_qi(this: *mut DataObject, iid: *const GUID, out: *mut *mut c_void) -> HRESULT {
    if out.is_null() {
        return E_POINTER;
    }
    if same(&*iid, &IID_IUNKNOWN) || same(&*iid, &IID_IDATAOBJECT) {
        do_add_ref(this);
        *out = this as *mut c_void;
        S_OK
    } else {
        *out = null_mut();
        E_NOINTERFACE
    }
}
unsafe extern "system" fn do_add_ref(this: *mut DataObject) -> u32 {
    (*this).refs.fetch_add(1, Ordering::SeqCst) + 1
}
unsafe extern "system" fn do_release(this: *mut DataObject) -> u32 {
    let left = (*this).refs.fetch_sub(1, Ordering::SeqCst) - 1;
    if left == 0 {
        drop(Box::from_raw(this));
    }
    left
}
unsafe extern "system" fn do_get_data(this: *mut DataObject, f: *const FORMATETC, m: *mut STGMEDIUM) -> HRESULT {
    if f.is_null() || m.is_null() {
        return E_POINTER;
    }
    let me = &*this;
    if !me.offers(&*f) {
        return DV_E_FORMATETC;
    }
    let cf = (*f).cfFormat;
    let data = if cf == CF_HDROP {
        Some(me.hdrop.clone())
    } else if cf == me.png_cf {
        me.png_bytes()
    } else if cf == CF_DIBV5 {
        me.dib_bytes()
    } else {
        None
    };
    let Some(bytes) = data else { return DV_E_FORMATETC };
    let Some(h) = global_from(&bytes) else { return E_OUTOFMEMORY };
    // the receiver owns and frees the HGLOBAL (ReleaseStgMedium with no pUnkForRelease)
    let medium = &mut *m;
    medium.tymed = TYMED_HGLOBAL as _;
    medium.u.hGlobal = h;
    medium.pUnkForRelease = null_mut();
    S_OK
}
unsafe extern "system" fn do_get_data_here(_: *mut DataObject, _: *const FORMATETC, _: *mut STGMEDIUM) -> HRESULT {
    E_NOTIMPL
}
unsafe extern "system" fn do_query_get_data(this: *mut DataObject, f: *const FORMATETC) -> HRESULT {
    if f.is_null() {
        return E_POINTER;
    }
    if (*this).offers(&*f) { S_OK } else { DV_E_FORMATETC }
}
unsafe extern "system" fn do_canonical(_: *mut DataObject, _: *const FORMATETC, out: *mut FORMATETC) -> HRESULT {
    if !out.is_null() {
        (*out).ptd = null_mut();
    }
    DATA_S_SAMEFORMATETC
}
unsafe extern "system" fn do_set_data(_: *mut DataObject, _: *const FORMATETC, _: *const STGMEDIUM, _: i32) -> HRESULT {
    E_NOTIMPL
}
unsafe extern "system" fn do_enum_format_etc(this: *mut DataObject, direction: u32, out: *mut *mut c_void) -> HRESULT {
    if out.is_null() {
        return E_POINTER;
    }
    if direction != 1 {
        // DATADIR_GET only: nothing can be set
        *out = null_mut();
        return E_NOTIMPL;
    }
    *out = EnumFormats::new((*this).formats.clone(), 0) as *mut c_void;
    S_OK
}
unsafe extern "system" fn do_d_advise(_: *mut DataObject, _: *const FORMATETC, _: u32, _: *mut c_void, _: *mut u32) -> HRESULT {
    OLE_E_ADVISENOTSUPPORTED
}
unsafe extern "system" fn do_d_unadvise(_: *mut DataObject, _: u32) -> HRESULT {
    OLE_E_ADVISENOTSUPPORTED
}
unsafe extern "system" fn do_enum_d_advise(_: *mut DataObject, out: *mut *mut c_void) -> HRESULT {
    if !out.is_null() {
        *out = null_mut();
    }
    OLE_E_ADVISENOTSUPPORTED
}

static DATA_OBJECT_VTBL: DataObjectVtbl = DataObjectVtbl {
    query_interface: do_qi,
    add_ref: do_add_ref,
    release: do_release,
    get_data: do_get_data,
    get_data_here: do_get_data_here,
    query_get_data: do_query_get_data,
    get_canonical_format_etc: do_canonical,
    set_data: do_set_data,
    enum_format_etc: do_enum_format_etc,
    d_advise: do_d_advise,
    d_unadvise: do_d_unadvise,
    enum_d_advise: do_enum_d_advise,
};

// ── IEnumFORMATETC (the data object's formats) ──

#[repr(C)]
struct EnumVtbl {
    query_interface: unsafe extern "system" fn(*mut EnumFormats, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut EnumFormats) -> u32,
    release: unsafe extern "system" fn(*mut EnumFormats) -> u32,
    next: unsafe extern "system" fn(*mut EnumFormats, u32, *mut FORMATETC, *mut u32) -> HRESULT,
    skip: unsafe extern "system" fn(*mut EnumFormats, u32) -> HRESULT,
    reset: unsafe extern "system" fn(*mut EnumFormats) -> HRESULT,
    clone: unsafe extern "system" fn(*mut EnumFormats, *mut *mut c_void) -> HRESULT,
}

#[repr(C)]
struct EnumFormats {
    vtbl: *const EnumVtbl,
    refs: AtomicU32,
    formats: Vec<FORMATETC>,
    at: u32,
}

impl EnumFormats {
    fn new(formats: Vec<FORMATETC>, at: u32) -> *mut EnumFormats {
        Box::into_raw(Box::new(EnumFormats { vtbl: &ENUM_VTBL, refs: AtomicU32::new(1), formats, at }))
    }
}

unsafe extern "system" fn ef_qi(this: *mut EnumFormats, iid: *const GUID, out: *mut *mut c_void) -> HRESULT {
    if out.is_null() {
        return E_POINTER;
    }
    if same(&*iid, &IID_IUNKNOWN) || same(&*iid, &IID_IENUMFORMATETC) {
        ef_add_ref(this);
        *out = this as *mut c_void;
        S_OK
    } else {
        *out = null_mut();
        E_NOINTERFACE
    }
}
unsafe extern "system" fn ef_add_ref(this: *mut EnumFormats) -> u32 {
    (*this).refs.fetch_add(1, Ordering::SeqCst) + 1
}
unsafe extern "system" fn ef_release(this: *mut EnumFormats) -> u32 {
    let left = (*this).refs.fetch_sub(1, Ordering::SeqCst) - 1;
    if left == 0 {
        drop(Box::from_raw(this));
    }
    left
}
unsafe extern "system" fn ef_next(this: *mut EnumFormats, n: u32, out: *mut FORMATETC, fetched: *mut u32) -> HRESULT {
    if out.is_null() || (n > 1 && fetched.is_null()) {
        return E_POINTER;
    }
    let me = &mut *this;
    let mut got = 0;
    while got < n && (me.at as usize) < me.formats.len() {
        *out.add(got as usize) = me.formats[me.at as usize];
        me.at += 1;
        got += 1;
    }
    if !fetched.is_null() {
        *fetched = got;
    }
    if got == n { S_OK } else { S_FALSE }
}
unsafe extern "system" fn ef_skip(this: *mut EnumFormats, n: u32) -> HRESULT {
    let count = (*this).formats.len() as u32;
    let next = (*this).at.saturating_add(n);
    (*this).at = next.min(count);
    if next <= count { S_OK } else { S_FALSE }
}
unsafe extern "system" fn ef_reset(this: *mut EnumFormats) -> HRESULT {
    (*this).at = 0;
    S_OK
}
unsafe extern "system" fn ef_clone(this: *mut EnumFormats, out: *mut *mut c_void) -> HRESULT {
    if out.is_null() {
        return E_POINTER;
    }
    *out = EnumFormats::new((*this).formats.clone(), (*this).at) as *mut c_void;
    S_OK
}

static ENUM_VTBL: EnumVtbl = EnumVtbl {
    query_interface: ef_qi,
    add_ref: ef_add_ref,
    release: ef_release,
    next: ef_next,
    skip: ef_skip,
    reset: ef_reset,
    clone: ef_clone,
};

// ── IDropSource ──

/// The engine's answers: whether to go on, drop or cancel (QueryContinueDrag), and the effect the
/// target under the cursor offers (GiveFeedback), for the card. `feedback` returns true when it
/// has set the cursor itself (hidden during a layer drag), false for OLE's default cursors.
pub struct Decisions {
    pub query_continue: fn(escape: bool, keys: u32) -> HRESULT,
    pub feedback: fn(effect: u32) -> bool,
}

#[repr(C)]
struct DropSourceVtbl {
    query_interface: unsafe extern "system" fn(*mut DropSource, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut DropSource) -> u32,
    release: unsafe extern "system" fn(*mut DropSource) -> u32,
    query_continue_drag: unsafe extern "system" fn(*mut DropSource, i32, u32) -> HRESULT,
    give_feedback: unsafe extern "system" fn(*mut DropSource, u32) -> HRESULT,
}

#[repr(C)]
struct DropSource {
    vtbl: *const DropSourceVtbl,
    refs: AtomicU32,
    decisions: Decisions,
    feedbacks: AtomicU32,
}

unsafe extern "system" fn ds_qi(this: *mut DropSource, iid: *const GUID, out: *mut *mut c_void) -> HRESULT {
    if out.is_null() {
        return E_POINTER;
    }
    if same(&*iid, &IID_IUNKNOWN) || same(&*iid, &IID_IDROPSOURCE) {
        ds_add_ref(this);
        *out = this as *mut c_void;
        S_OK
    } else {
        *out = null_mut();
        E_NOINTERFACE
    }
}
unsafe extern "system" fn ds_add_ref(this: *mut DropSource) -> u32 {
    (*this).refs.fetch_add(1, Ordering::SeqCst) + 1
}
unsafe extern "system" fn ds_release(this: *mut DropSource) -> u32 {
    let left = (*this).refs.fetch_sub(1, Ordering::SeqCst) - 1;
    if left == 0 {
        drop(Box::from_raw(this));
    }
    left
}
unsafe extern "system" fn ds_query_continue(this: *mut DropSource, escape: i32, keys: u32) -> HRESULT {
    ((*this).decisions.query_continue)(escape != 0, keys)
}
unsafe extern "system" fn ds_give_feedback(this: *mut DropSource, effect: u32) -> HRESULT {
    (*this).feedbacks.fetch_add(1, Ordering::SeqCst);
    if ((*this).decisions.feedback)(effect) { S_OK } else { DRAGDROP_S_USEDEFAULTCURSORS }
}

static DROP_SOURCE_VTBL: DropSourceVtbl = DropSourceVtbl {
    query_interface: ds_qi,
    add_ref: ds_add_ref,
    release: ds_release,
    query_continue_drag: ds_query_continue,
    give_feedback: ds_give_feedback,
};

/// OleInitialize for the calling thread (the engine thread, once).
pub fn init() -> HRESULT {
    unsafe { OleInitialize(null_mut()) }
}

pub struct Result {
    pub hr: HRESULT,
    pub effect: u32,
    /// GiveFeedback calls: 0 means OLE never tracked the mouse over a target
    pub feedbacks: u32,
}

/// Runs a copy-only DoDragDrop of `files` until the release or Escape. Blocks (it runs OLE's own
/// modal loop, which keeps pumping this thread's messages, so the mouse hook still runs).
pub fn drag(files: &[PathBuf], decisions: Decisions) -> Result {
    let png_cf = png_format_id();
    let formats = offered_formats(files.len(), png_cf).into_iter().map(format).collect();
    let data = Box::into_raw(Box::new(DataObject {
        vtbl: &DATA_OBJECT_VTBL,
        refs: AtomicU32::new(1),
        hdrop: hdrop_bytes(files),
        formats,
        png_cf,
        image: (files.len() == 1).then(|| files[0].clone()),
        png: RefCell::new(None),
        dib: RefCell::new(None),
    }));
    let source = Box::into_raw(Box::new(DropSource {
        vtbl: &DROP_SOURCE_VTBL,
        refs: AtomicU32::new(1),
        decisions,
        feedbacks: AtomicU32::new(0),
    }));
    let mut effect = 0u32;
    unsafe {
        let hr = DoDragDrop(data as *mut c_void, source as *mut c_void, DROPEFFECT_COPY, &mut effect);
        let feedbacks = (*source).feedbacks.load(Ordering::SeqCst);
        ds_release(source);
        do_release(data);
        Result { hr, effect, feedbacks }
    }
}
