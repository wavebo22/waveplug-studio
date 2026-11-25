// `waveplug-overlay --demo`: the external generate panel with made-up data and no Photoshop or
// ComfyUI, for checking the UI (HANDOFF.md §10 phase 2). The rules that fill hint / action /
// blocked here stand in for the plugin's own (src/ui/app.ts) and go away in phase 3.

use std::time::{Duration, Instant};

use eframe::egui::{
    self, vec2, Align2, Color32, CornerRadius, Frame, Id, Margin, RichText, Sense, Stroke,
    ViewportCommand,
};

use super::state::{Action, Mode, PanelState, Param, RefSlot, RefSource, Reference, Run, Tone, MAX_REFERENCE_SLOTS};
use super::view;
use crate::panel::theme::{self, *};

const RUN_TIME: Duration = Duration::from_millis(4500);
pub fn run() {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("WavePlug 外置生成面板 Demo")
            .with_inner_size([340.0, 560.0])
            .with_min_inner_size([280.0, 260.0])
            .with_decorations(false)
            .with_always_on_top()
            .with_resizable(true),
        ..Default::default()
    };
    let _ = eframe::run_native(
        "WavePlug 外置生成面板 Demo",
        options,
        Box::new(|cc| {
            theme::install(&cc.egui_ctx);
            Ok(Box::new(Demo::new()))
        }),
    );
}

struct Demo {
    s: PanelState,
    /// stands in for Photoshop's selection (the real panel only shows while there is one)
    selection: bool,
    started: Option<Instant>,
    toast: Option<(String, Instant)>,
    placed: bool,
    seed: u64,
    /// 保留原图细节 while a mode that doesn't have it is shown
    hidden_keep: Option<Param>,
    /// WAVEPLUG_DEMO_SHOT=<file.bmp>: save one picture of the window and quit (for checking the
    /// layout without a screen recorder); WAVEPLUG_DEMO_OPEN=adv,fav,sel,run,ref opens those parts
    shot: Option<crate::shot::Shot>,
}

impl Demo {
    fn new() -> Self {
        let mut d = Demo {
            s: PanelState {
                mode: Some(Mode::Blend),
                prompt: String::new(),
                hint: String::new(),
                favorites: vec![
                    "夕阳暖光，木桌上的倒影".into(),
                    "柔和的棚拍光，浅灰背景".into(),
                ],
                refs: vec![RefSlot {
                    slot: 1,
                    filled: None,
                }],
                count: 1,
                action: String::new(),
                blocked: None,
                note: None,
                params: vec![
                    Param::Number {
                        key: "12.strength".into(),
                        label: "LoRA 强度".into(),
                        value: 0.8,
                        base: 0.8,
                        min: 0.0,
                        max: 2.0,
                        int: false,
                    },
                    Param::Number {
                        key: "3.steps".into(),
                        label: "步数".into(),
                        value: 8.0,
                        base: 8.0,
                        min: 1.0,
                        max: 50.0,
                        int: true,
                    },
                    Param::Number {
                        key: "3.denoise".into(),
                        label: "重绘强度".into(),
                        value: 1.0,
                        base: 1.0,
                        min: 0.0,
                        max: 1.0,
                        int: false,
                    },
                    Param::Seed {
                        random: true,
                        value: 202611040,
                    },
                    Param::Toggle {
                        key: "localMask".into(),
                        label: "只重绘选区内".into(),
                        value: true,
                        tip: "把遮罩接到工作流，让模型只在选区内生成".into(),
                    },
                    Param::Toggle {
                        key: "keepDetail".into(),
                        label: "保留原图细节".into(),
                        value: true,
                        tip: "光影、阴影和颜色用 AI 的结果，纹理和文字等细节用原图".into(),
                    },
                    Param::Toggle {
                        key: "fullRun".into(),
                        label: "每次完整运行（不使用 ComfyUI 缓存，较慢）".into(),
                        value: false,
                        tip: String::new(),
                    },
                ],
                running: None,
                status: Some((Tone::Info, "就绪".into())),
                fav_open: false,
                adv_open: false,
                ref_menu: None,
                count_text: "1".into(),
                prompt_focused: false,
                count_focused: false,
                external_drag: None,
            },
            selection: false,
            started: None,
            toast: None,
            placed: false,
            seed: 0x9e37_79b9_7f4a_7c15,
            hidden_keep: None,
            shot: crate::shot::Shot::from_env("WAVEPLUG_DEMO_SHOT"),
        };
        let open = std::env::var("WAVEPLUG_DEMO_OPEN").unwrap_or_default();
        d.s.adv_open = open.contains("adv");
        d.s.fav_open = open.contains("fav");
        d.selection = open.contains("sel");
        if open.contains("ref") {
            d.apply(Action::AddRef {
                slot: 1,
                source: RefSource::Layer,
            });
        }
        if open.contains("prompt") {
            d.s.prompt = "把杯子放在木桌上，夕阳暖光".into();
        }
        d.derive();
        if open.contains("run") {
            d.apply(Action::Generate(None));
        }
        d
    }

    /// what the plugin would work out for the current mode (app.ts promptHint / renderAction / blockedReason)
    fn derive(&mut self) {
        let s = &mut self.s;
        let mode = s.mode.unwrap_or(Mode::Inpaint);
        s.hint = match mode {
            Mode::Inpaint => "描述要画进选区的内容；留空 = 移除选区内的内容",
            Mode::Blend => "可选：补充光影要求，例如 夕阳暖光、木桌上的倒影；留空 = 默认融图提示词",
            Mode::Extract => "可选：要抠的东西，例如 护肤品、红色价格牌；留空 = 抠选区里的主体",
            Mode::Txt2img => "描述想要生成的画面",
        }
        .into();
        s.action = match mode {
            Mode::Blend => "融图",
            Mode::Extract => "抠图",
            Mode::Inpaint | Mode::Txt2img => "生成",
        }
        .into();
        s.blocked = if mode == Mode::Txt2img && s.prompt.trim().is_empty() {
            Some("请输入提示词".into())
        } else if mode != Mode::Txt2img && !self.selection {
            Some(
                match mode {
                    Mode::Blend => "请先框选要融合的产品和它周围一圈",
                    Mode::Extract => "请先框选要抠的东西",
                    _ => "请先建立选区",
                }
                .into(),
            )
        } else {
            None
        };
        // 保留原图细节 only exists for 融图 / 抠图
        let keep = matches!(mode, Mode::Blend | Mode::Extract);
        if let Some(i) = s
            .params
            .iter()
            .position(|p| matches!(p, Param::Toggle { key, .. } if key == "keepDetail"))
        {
            if !keep {
                self.hidden_keep = Some(s.params.remove(i));
            }
        } else if keep {
            if let Some(p) = self.hidden_keep.take() {
                let at = s.params.len().saturating_sub(1);
                s.params.insert(at, p);
            }
        }
    }

    fn next_seed(&mut self) -> u64 {
        // xorshift: enough for a demo
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 7;
        self.seed ^= self.seed << 17;
        self.seed % 1_000_000_000_000
    }

    fn apply(&mut self, a: Action) {
        let s = &mut self.s;
        match a {
            Action::SetMode(m) => s.mode = Some(m),
            Action::SetPrompt(_) => {}
            Action::ToggleFavorite => {
                let t = s.prompt.trim().to_string();
                if let Some(i) = s.favorites.iter().position(|x| *x == t) {
                    s.favorites.remove(i);
                } else if !t.is_empty() {
                    s.favorites.insert(0, t);
                }
            }
            Action::PickFavorite(t) => {
                s.prompt = t;
                s.fav_open = false;
            }
            Action::RemoveFavorite(t) => s.favorites.retain(|x| *x != t),
            Action::AddRef { slot, source } => {
                let name = match source {
                    RefSource::Layer => "图层 9 拷贝 11",
                    RefSource::File => "参考_饮料.png",
                    RefSource::Clipboard => "剪贴板图片",
                };
                if let Some(r) = s.refs.iter_mut().find(|r| r.slot == slot) {
                    r.filled = Some(Reference {
                        tag: format!("图{}", slot + 1),
                        name: name.into(),
                        thumb: None,
                        texture: None,
                        texture_error: None,
                    });
                }
                // filled slots plus one empty "add" slot, up to eight (app.ts refSlotNumbers)
                if s.refs.iter().all(|r| r.filled.is_some()) && s.refs.len() < MAX_REFERENCE_SLOTS as usize {
                    let next = s.refs.len() as u32 + 1;
                    s.refs.push(RefSlot {
                        slot: next,
                        filled: None,
                    });
                }
            }
            Action::DropRefs { slot, layers, .. } => {
                if let Some(r) = s.refs.iter_mut().find(|r| r.slot == slot) {
                    r.filled = Some(Reference {
                        tag: format!("图{}", slot + 1),
                        name: layers.first().map(|layer| layer.name.clone()).unwrap_or_else(|| "图层".into()),
                        thumb: None,
                        texture: None,
                        texture_error: None,
                    });
                }
            }
            Action::RemoveRef(slot) => {
                if let Some(r) = s.refs.iter_mut().find(|r| r.slot == slot) {
                    r.filled = None;
                }
                while s.refs.len() > 1
                    && s.refs[s.refs.len() - 1].filled.is_none()
                    && s.refs[s.refs.len() - 2].filled.is_none()
                {
                    s.refs.pop();
                }
            }
            Action::SetCount(n) => s.count = n,
            Action::SetNumber { key, value } => {
                for p in s.params.iter_mut() {
                    if let Param::Number {
                        key: k, value: v, ..
                    } = p
                    {
                        if *k == key {
                            *v = value;
                        }
                    }
                }
            }
            Action::ResetNumber(key) => {
                for p in s.params.iter_mut() {
                    if let Param::Number {
                        key: k,
                        value,
                        base,
                        ..
                    } = p
                    {
                        if *k == key {
                            *value = *base;
                        }
                    }
                }
            }
            Action::SetToggle { .. } | Action::SetSeed { .. } => {}
            Action::NewSeed => {
                let n = self.next_seed();
                for p in self.s.params.iter_mut() {
                    if let Param::Seed { random, value } = p {
                        *random = false;
                        *value = n;
                    }
                }
            }
            Action::Generate(_) => {
                s.running = Some(Run {
                    stage: "准备中…".into(),
                    progress: 0.0,
                });
                s.status = Some((Tone::Info, format!("{}中…", s.action)));
                self.started = Some(Instant::now());
            }
            Action::Cancel => {
                s.running = None;
                s.status = Some((Tone::Info, "已取消".into()));
                self.started = None;
            }
        }
    }

    /// a made-up run: stages and progress over RUN_TIME, then a toast
    fn tick(&mut self, ctx: &egui::Context) {
        let Some(t0) = self.started else { return };
        let k = t0.elapsed().as_secs_f32() / RUN_TIME.as_secs_f32();
        if k >= 1.0 {
            self.started = None;
            self.s.running = None;
            let msg = format!("{}完成 · {} 个变体", self.s.action, self.s.count);
            self.s.status = Some((Tone::Ok, msg.clone()));
            self.toast = Some((msg, Instant::now()));
            return;
        }
        let stage = if k < 0.15 {
            "读取选区和画面"
        } else if k < 0.3 {
            "上传到 ComfyUI"
        } else if k < 0.9 {
            "生成中"
        } else {
            "写回图层"
        };
        if let Some(r) = &mut self.s.running {
            r.progress = k;
            r.stage = format!("{stage} · {}%", (k * 100.0) as u32);
        }
        ctx.request_repaint_after(Duration::from_millis(33));
    }
}

impl eframe::App for Demo {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // first frame: bottom-right of the screen, where Photoshop's canvas corner would be
        if !self.placed {
            if let Some(m) = ctx.input(|i| i.viewport().monitor_size) {
                let size = ctx
                    .input(|i| i.viewport().outer_rect.map(|r| r.size()))
                    .unwrap_or(vec2(340.0, 560.0));
                ctx.send_viewport_cmd(ViewportCommand::OuterPosition(egui::pos2(
                    (m.x - size.x - 48.0).max(0.0),
                    (m.y - size.y - 96.0).max(0.0),
                )));
                self.placed = true;
            }
        }
        if ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
            ctx.send_viewport_cmd(ViewportCommand::Close);
        }
        self.tick(ctx);
        if let Some(shot) = &mut self.shot {
            shot.frame(ctx, 8);
        }

        let mut actions = Vec::new();
        egui::CentralPanel::default()
            .frame(
                Frame::new()
                    .fill(BG)
                    .stroke(Stroke::new(1.0_f32, LINE))
                    .inner_margin(Margin::same(8)),
            )
            .show(ctx, |ui| {
                // the panel's own background drags the window (no title bar)
                let drag = ui.interact(ui.max_rect(), Id::new("drag"), Sense::drag());
                if drag.drag_started() {
                    ctx.send_viewport_cmd(ViewportCommand::StartDrag);
                }
                // demo-only controls, kept apart from the panel at the bottom
                egui::TopBottomPanel::bottom("demo-bar")
                    .frame(Frame::new().fill(BG).inner_margin(Margin::symmetric(0, 4)))
                    .show_inside(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new("仅 Demo：").size(FS_S).color(TEXT_3));
                            ui.checkbox(
                                &mut self.selection,
                                RichText::new("PS 有选区").size(FS_S).color(TEXT_3),
                            );
                            ui.label(
                                RichText::new("· Esc 退出 · 拖空白处移动")
                                    .size(FS_S)
                                    .color(TEXT_3),
                            );
                        });
                    });
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        actions = view::panel(ui, &mut self.s);
                    });
            });
        for a in actions {
            self.apply(a);
        }
        self.derive();

        if let Some((msg, at)) = &self.toast {
            if at.elapsed() < Duration::from_secs(3) {
                egui::Area::new(Id::new("toast"))
                    .anchor(Align2::CENTER_TOP, vec2(0.0, 44.0))
                    .show(ctx, |ui| {
                        Frame::new()
                            .fill(Color32::from_rgb(0x1d, 0x1d, 0x1d))
                            .stroke(Stroke::new(1.0_f32, OK))
                            .corner_radius(CornerRadius::same(R))
                            .inner_margin(Margin::symmetric(12, 8))
                            .show(ui, |ui| {
                                ui.label(RichText::new(format!("✓ {msg}")).size(FS).color(TEXT))
                            });
                    });
                ctx.request_repaint_after(Duration::from_millis(200));
            } else {
                self.toast = None;
            }
        }
    }
}
