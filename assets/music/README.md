# Background music

Drop your background track here as `background.mp3` (the filename is set by
`MUSIC_FILE` in `.env`, default `assets/music/background.mp3`).

If no file is present, the server **synthesizes a soft ambient placeholder**
automatically on first run, so the channel always has audio. Replace it with
your own royalty-free / licensed track for production use.

Supported: anything ffmpeg can read (mp3, m4a, aac, wav, ogg…). It is looped
to fill the channel duration automatically.
