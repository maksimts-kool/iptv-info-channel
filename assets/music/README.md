# Background music

The bundled `background.mp3` is the default channel soundtrack.

Set `MUSIC_FILE` to use another royalty-free or licensed track. If that custom
path is missing, the server falls back to this bundled file. A soft ambient
placeholder is synthesized only if neither file is available.

Supported: anything ffmpeg can read (mp3, m4a, aac, wav, ogg…). It is looped
to fill the channel duration automatically.
