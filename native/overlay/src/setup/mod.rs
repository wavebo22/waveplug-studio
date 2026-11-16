// The installing code, shared: the WavePlug app (WavePlug.exe, this crate's main bin) uses it for
// its 安装与更新 page; the installer (waveplug-setup, src/setup/main.rs) includes the same files.

#![allow(dead_code)]

pub mod detect;
pub mod install;
pub mod payload;
pub mod sys;
pub mod update;
