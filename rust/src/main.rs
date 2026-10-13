// Temporary while the port is in progress: modules land before their callers.
#![allow(dead_code)]
//! IPTV subscription server: curated provider catalog, per-customer `.m3u`
//! playlists, and the built-in info and media channels.

mod core;
mod epg;
mod data;
mod news;
mod playlist;
mod render;

fn main() {}
