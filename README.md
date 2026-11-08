# musicfit

Fit a music track to a video cut. musicfit makes the track exactly as long as the video by cutting or looping whole bars, lands its drop on the second you pick, ends it on a beat, ducks it under a voice and sets its loudness. Give it the video too and it lays the track under it.

```bash
npx musicfit@latest track.mp3 --length 32 --hit 27.5 --fps 30
```

![A 97 second house track fitted to 32 seconds with its drop on 27.5 s and a voice over it](.github/assets/seams.png)

AI music models ignore the length you ask for. Ask for 30 seconds and you may get 47, or two minutes, and the drop the edit was built around comes whenever it comes. So the track gets cut at the video's last frame and stops in the middle of a bar, or it fades out on no beat in particular, and the big hit lands a second after the logo. Fixing that by hand means finding the bar lines in a waveform, cutting on them, nudging crossfades and doing the arithmetic for where the drop has to go. musicfit does it the way a music editor would: it finds the beats and the bar lines, cuts or loops whole bars where they sound alike, keeps the start and the ending of the track, and tells you which seconds to listen to.

The track can come from any music model, and [Wiro](https://wiro.ai/explore/music-generation) has several.

## What you get

```
musicfit-track/
  fitted.wav     the track, exactly --length long, 48 kHz stereo, at -14 LUFS
  mix.wav        with --voice: the voice over the ducked music
  video.mp4      with --video: the video with the track under it, its picture as it was
  cues.json      every beat and bar, the hit, the seams and the fade, in seconds and frames
  seams.png      the track, the result and what went where, like the picture above
  FIT.md         what was done and where to listen, for people and agents
```

- Cuts and loops are made only on bar lines, in whole bars, between bars that sound alike, and keep the track's four-bar phrases whole where they can. Each seam is a 30 ms crossfade that ends just before the downbeat, so the new bar's first hit plays whole, and the hits on either side are lined up to the millisecond.
- The drop lands on `--hit` to the sample, on the start of its attack. Nothing that comes after the drop in the track plays before it, so it is heard first where you asked.
- The track starts the way it starts, with its own pickup, and ends on its own last hit when it has one and there is room. Otherwise it ends with a fade that starts on a beat and ends on one.
- `--voice` lowers the music 10 dB (`--duck`) wherever the voice speaks, starting 0.15 s before each phrase and coming back 0.5 s after.
- `--video` lays the result under a video in `video.mp4`: the video's picture copied packet for packet, never encoded again, and the sound encoded as AAC at 256 kb/s at the loudness target, measured as a player decodes it and limited again until its true peak is under -1 dBTP (of four tries at most the one with the lowest true peak is kept, and FIT.md says so when that is still over). `--video-sound` says what becomes of the video's own sound. `keep`, for sound effects, sets it with one gain to the loudness target where it plays, its shortest clicks included, and dips the music half of `--duck` (5 dB) there, so the effects stand over the track, even ones much quieter than it in the video. `voice`, for speech, sets it to the loudness target where it speaks and dips the music `--duck` (10 dB) there, as under `--voice`; when no speech is found in it, it is kept as a faint room tone is, and a note says so. `drop`, for music of its own, leaves it out. A sound with nothing in it that stands out, such as a faint room tone, is never raised: it is only turned down to the loudness target if it is louder. The music, the voice and the video's own sound are then set to the loudness target together, which moves them all by the same amount. With `keep` and `voice` the music dips under the video's own sound in `fitted.wav` and `mix.wav` too, as it does under a voice, so `fitted.wav` reads quieter as a whole than the target, as FIT.md says. musicfit cannot tell speech from effects or from music, so a video with more than a faint room tone of its own, a single click included, is refused before the track is read until `--video-sound` is given; a video whose own sound is silent or a faint room tone keeps it. When the video itself is given as the track or as `--voice` (the same file), its sound is laid in once. A voice the video already holds goes with `--video-sound voice`, not as a copy given to `--voice`, which would lay it in twice. The video has to be `--length` long to a frame, counted from its first frame, and without `--fps` the frames count at its frame rate. A frame left out of a steady frame rate, as a recording that dropped frames has, or a cut made without encoding again that keeps a frame from after its end, still counts as a place at that rate. In `video.mp4` that first frame and the sound start together, and the video's own sound stays where it was against the picture, also in an MPEG-TS or a fragmented MP4 whose picture and sound start apart. A video that cannot be read, is cut short or damaged, has no picture, holds a picture an MP4 cannot take without encoding it again, or is another length is refused before any work, and so is a video musicfit made, unless `drop` leaves out its sound and the fitted track in it. `video.mp4` carries a comment that says musicfit made it; it names no file.
- Loudness is measured with ffmpeg's EBU R128 meter and set with one gain; a true-peak limiter holds the peaks under -1 dBTP only when that gain would push them over.
- `cues.json` lists `beats`, `bars` and `hits` (the drop and the track's own last hit) as frame numbers at `--fps`, ready for a Remotion `<Sequence from={cues.bars[8]}>`, and the same moments in seconds under `times`. The seams, sections, fade and loudness are in it too:

```json
{
  "fps": 30,
  "frames": 960,
  "bpm": 124,
  "beats": [12, 26, 41, 55, 70, 84],
  "bars": [12, 70, 128, 186],
  "hits": [825, 883],
  "times": { "beats": [0.394, 0.878, 1.362], "hits": [27.5, 29.427] },
  "drop": { "time": 27.5, "frame": 825, "source": 30.972, "sourceBar": 17 },
  "seams": [{ "time": 4.265, "frame": 128, "kind": "cut", "bars": 2, "likeness": 0.91 }]
}
```

The lists are cut short here; the file has every beat and bar.

`--analyze` reads a track without fitting it and saves its `cues.json`, `seams.png` and `FIT.md` in `musicfit-track.analysis/` by default. No fit's folder can have that name, so reading a track never replaces a fit, unless both are given the same `--out`.

A run makes its files in a hidden folder whose name starts with `.musicfit-part-`, inside the out folder (or next to it when the run makes the out folder), and puts them in place only once it has ended well. Nothing is made before the run writes its first file, after the track is read. A run that fails, is refused or is stopped with Ctrl-C or a signal leaves the out folder as it was: the earlier run's files stay and nothing is added. A run that ends well replaces the files the earlier run's `cues.json` lists and removes those it did not make again, like `mix.wav` after a fit with no voice. A file under one of musicfit's names (`fitted.wav`, `mix.wav`, `video.mp4`, `cues.json`, `seams.png`, `FIT.md`) that no musicfit `cues.json` there lists is not musicfit's: a run that would write over it is refused before any work, and one that would not leaves it alone, as it leaves files under other names. A run whose track, voice or video is one of the files it would replace or remove is refused before any work too. Two runs that end at the same moment in one folder take turns, and the later one's files are what is left. When a file is held open by another program and cannot be moved, the run says so, takes its own new files out again and puts the earlier files back; any earlier file it cannot put back waits in a folder the message names, with a note of where each file belongs and nothing else, and no later run removes that folder. When a run that did not end well cannot remove its own hidden folder, as when the out folder may no longer be changed, its message names that folder too; a later run that ends well in the same place removes it once it is 15 minutes old. A run killed outright (`kill -9`, or the system when memory runs out) after it began writing cannot tidy up: its hidden folder stays, and if it was killed in the moment it moved its files in, some of the earlier files can be in there, and a `.musicfit-commit` file stays in the out folder. A later run that ends well in the same place removes that folder once the killed run's process is gone and nothing in the folder has changed for 15 minutes, and takes the `.musicfit-commit` file away when it puts its own files in.

## Use it with your agent

musicfit ships as an [Agent Skill](https://agentskills.io). Install it once and your agent runs it by itself when a video needs music that fits:

```bash
npx skills add EminBudak/musicfit
```

That covers Claude Code, Codex, Cursor and the other agents the [`skills`](https://github.com/vercel-labs/skills) CLI supports. In Claude Code you can add it as a plugin instead:

```
/plugin marketplace add EminBudak/musicfit
/plugin install musicfit@musicfit
```

In GitHub Copilot CLI it takes the same two steps:

```bash
copilot plugin marketplace add EminBudak/musicfit
copilot plugin install musicfit@musicfit
```

Then ask as usual:

> Fit track.mp3 to my 30 second launch video, with the drop on the logo at 24 seconds

The skill carries its own script, so it installs nothing else and needs no API key.

## Use it from the command line

```
npx musicfit@latest <track> --length <time> [options]

  --length <time>   how long the result is, e.g. 32, 32s, 960f or 1:05
  --hit <time>      where the drop lands in the result
  --drop <time>     where the drop is in the track (default: found)
  --fps <n>         frame rate for frame numbers, e.g. 30, 25, 29.97
                    (default: the video's with --video, else 30)
  --voice <file>    a voice track on the video's timeline; the music dips under it
  --duck <dB>       how far the music dips under the voice (default: 10)
  --video <file>    a video to lay the result under: also writes video.mp4,
                    the video's picture as it was with this sound under it.
                    The video has to be --length long, to a frame
  --video-sound <how>
                    what becomes of the video's own sound: keep (sound
                    effects: set to --lufs where they play, and the music
                    dips half of --duck under them), voice (speech: set to
                    --lufs where it plays, and the music dips --duck under
                    it) or drop (music of its own: left out). A faint room
                    tone, or a voice with no speech found, is only turned
                    down to --lufs if it is louder. Without it, a video with
                    more than a faint room tone of its own is refused until
                    you choose
  --lufs <n>        loudness target in LUFS (default: -14)
  --end <kind>      auto, natural (the track's own ending) or fade (default: auto)
  --fade <s>        length of the closing fade, in whole beats (default: a bar)
  --bpm <n>         the tempo, when the one found is half or double the real one
  --meter <n>       beats to a bar, 3 or 4 (default: found)
  --out <dir>       where to save (default: ./musicfit-<track name>, or
                    ./musicfit-<track name>.analysis with --analyze)
  --analyze         only read the track: its beats, bars, drop and ending
  --json            print cues.json instead of a summary
```

Times are seconds unless they end in `f`, which counts frames at `--fps`, or with `--video` and no `--fps` at the video's frame rate. The track can be any file ffmpeg reads, the sound of a video included. musicfit reads files, not addresses: a track, a voice or a video given as `https://...` is refused, so download it first.

Some runs:

```bash
npx musicfit@latest track.mp3 --length 15
npx musicfit@latest track.mp3 --length 900f --hit 450f --fps 30 --out public/music
npx musicfit@latest track.mp3 --length 1:30 --hit 41 --voice vo.wav --lufs -16
npx musicfit@latest track.mp3 --length 733f --hit 600f --video film.mp4 --video-sound keep
npx musicfit@latest track.mp3 --length 32 --video talk.mp4 --video-sound voice
npx musicfit@latest track.mp3 --analyze
```

Installed globally (`npm install -g musicfit`), the command is `musicfit`. npx keeps the copy an earlier run fetched, so `npx musicfit@latest` is how you get a newer version.

It needs Node 22 or newer and ffmpeg 4.4 or newer (`brew install ffmpeg`, `sudo apt install ffmpeg` or `winget install ffmpeg`); the tests run on Ubuntu 22.04's ffmpeg 4.4 and on the latest Ubuntu's, before every release too. Set `FFMPEG_PATH` to pick the ffmpeg. There are no npm dependencies; the beat tracking is plain JavaScript and nothing leaves your machine.

## How it works

1. Decodes the track with ffmpeg and measures, in 10 ms frames, how much each of 40 frequency bands rises: the onsets.
2. Finds the period the onsets repeat at, then decides which of its halves, doubles or thirds is the beat. A tempo near 115 BPM is more likely, a kick and a snare taking turns says that is the beat people clap to, and a kick between the beats says the beat is faster. When the tempo could just as well be half or double, it says so.
3. Tracks the beats with dynamic programming (Ellis's method, as in librosa), moves each onto its onset, and fits them to one steady line when the tempo holds.
4. Finds the bar lines from where the kicks, the chord changes and the changes in loudness fall, and whether a bar has three beats or four.
5. Describes every bar by its harmony, timbre, loudness and rhythm, finds where sections change, the drop (the first time the track reaches its fullest after a quieter stretch, on a phrase line) and how the track ends.
6. Lays the result out as slots one bar long, lined up so a slot starts exactly on the hit, and fills them with bars of the track by dynamic programming: playing on costs nothing, a seam costs more the less its two sides sound like bars that follow each other in the track, and more again when it breaks a four-bar phrase or leaves a build before its drop.
7. Joins the bars with short crossfades, lines up the hits at every seam, fades the head and the tail, ducks the voice, sets the loudness, and writes the files. With `--video` it reads the video's packets first, to know its length and frame rate and to refuse what it cannot take, and at the end puts the new sound under its picture, which it copies as it is.

## Limits

- One hit per run. A second moment that must land on a beat can use the bar frames in `cues.json`.
- The tempo can be read as half or double the real one, the main failure of beat tracking. musicfit warns when both are likely and then cuts only in pairs of bars, which stays on the bar lines either way; `--bpm` settles it.
- When nothing in a track marks the first beat of the bar, the bar lines can come out a beat off. musicfit says when it is unsure, and the cuts still keep the beat, since they skip whole bars.
- A groove whose loudest hits fall between the beats over a sparse kick, as in some dembow and afrobeats patterns, can be read half a beat off without a warning. Listen to the first seam.
- Tracks with no steady beat (ambient, rubato piano) are joined with one-second crossfades where they sound alike, not on bar lines. Listen to every seam.
- A tempo that changes a lot within the track, or a bar of 2/4 in a 4/4 song, can put a seam a beat off.
- Seams follow bars and sound, not words: in a song with singing a cut can fall in the middle of a line. An instrumental fits best.
- Lengthening loops bars the track already has, so a 30 second track stretched to 3 minutes repeats, and so does the intro when the drop is asked for much later than the track has it (musicfit says how many times). Ask the music model for a little more than you need.
- `--video` copies the picture as it is, so a picture an MP4 cannot hold that way (ProRes, DNxHD, VP8) is refused rather than encoded again. Only the picture and the new sound go into `video.mp4`: subtitles and other streams of the video are left out.
- A fit holds its sound in memory a few times over, so memory grows with `--length`: a 10 minute fit took about 0.5 GB, 1 GB with `--video`, 1.2 GB with `--voice` and 1.5 GB with a voice and the video's own sound as well. A run takes a few seconds, and with `--video` of a long film a minute or more, most of it spent encoding the sound as AAC, again each time an encoding lifts its true peak over -1 dBTP, four times at most.
- musicfit cannot tell speech from sound effects or from music, which is why it asks for `--video-sound` when a video has sound of its own. With `keep` and `voice` the music dips under anything in that sound that stands out, a cough or a door as much as a word, and the sound is set with one gain, so a hiss or a hum under quiet effects or a quiet voice comes up with them.
- It does not change the tempo or the pitch, and it does not check whether you may use the track.

## See also

- [launch-film](https://github.com/EminBudak/launch-film) turns a site into a short launch film, rendered on your machine.
- [easyscreenshotkit](https://github.com/EminBudak/easyscreenshotkit) saves clean screenshots of a website's pages.
- [easybrandkit](https://github.com/EminBudak/easybrandkit) saves a site's real logo files, colors and fonts as a brand kit.

## License

MIT
