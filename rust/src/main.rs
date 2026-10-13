// Temporary while the port is in progress: modules land before their callers.
#![allow(dead_code)]
//! IPTV subscription server: curated provider catalog, per-customer `.m3u`
//! playlists, and the built-in info and media channels.

mod core;
mod data;
mod encode;
mod epg;
mod news;
mod playlist;
mod render;

fn main() {}
