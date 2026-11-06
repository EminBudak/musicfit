# musicfit

Fit a music track to a video cut. musicfit makes the track exactly as long as the video by cutting or looping whole bars, lands its drop on the second you pick, ends it on a beat, ducks it under a voice and sets its loudness.

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
  cues.json      every beat and bar, the hit, the seams and the fade, in seconds and frames
  seams.png      the track, the result and what went where, like the picture above
  FIT.md         what was done and where to listen, for people and agents
```

- Cuts and loops are made only on bar lines, in whole bars, between bars that sound alike, and keep the track's four-bar phrases whole where they can. Each seam is a 30 ms crossfade that ends just before the downbeat, so the new bar's first hit plays whole, and the hits on either side are lined up to the millisecond.
- The drop lands on `--hit` to the sample, on the start of its attack. Nothing that comes after the drop in the track plays before it, so it is heard first where you asked.
- The track starts the way it starts, with its own pickup, and ends on its own last hit when it has one and there is room. Otherwise it ends with a fade that starts on a beat and ends on one.
- `--voice` lowers the music 10 dB (`--duck`) wherever the voice speaks, starting 0.15 s before each phrase and coming back 0.5 s after.
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
  --fps <n>         frame rate for frame numbers, e.g. 30, 25, 29.97 (default: 30)
  --voice <file>    a voice track on the video's timeline; the music dips under it
  --duck <dB>       how far the music dips under the voice (default: 10)
  --lufs <n>        loudness target in LUFS (default: -14)
  --end <kind>      auto, natural (the track's own ending) or fade (default: auto)
  --fade <s>        length of the closing fade, in whole beats (default: a bar)
  --bpm <n>         the tempo, when the one found is half or double the real one
  --meter <n>       beats to a bar, 3 or 4 (default: found)
  --out <dir>       where to save (default: ./musicfit-<track name>)
  --analyze         only read the track: its beats, bars, drop and ending
  --json            print cues.json instead of a summary
```

Times are seconds unless they end in `f`, which counts frames at `--fps`. The track can be any file ffmpeg reads, the sound of a video included.

Some runs:

```bash
npx musicfit@latest track.mp3 --length 15
npx musicfit@latest track.mp3 --length 900f --hit 450f --fps 30 --out public/music
npx musicfit@latest track.mp3 --length 1:30 --hit 41 --voice vo.wav --lufs -16
npx musicfit@latest track.mp3 --analyze
```

Installed globally (`npm install -g musicfit`), the command is `musicfit`. npx keeps the copy an earlier run fetched, so `npx musicfit@latest` is how you get a newer version.

It needs Node 22 or newer and ffmpeg (`brew install ffmpeg`, `sudo apt install ffmpeg` or `winget install ffmpeg`). Set `FFMPEG_PATH` to pick the ffmpeg. There are no npm dependencies; the beat tracking is plain JavaScript and nothing leaves your machine.

## How it works

1. Decodes the track with ffmpeg and measures, in 10 ms frames, how much each of 40 frequency bands rises: the onsets.
2. Finds the period the onsets repeat at, then decides which of its halves, doubles or thirds is the beat. A tempo near 115 BPM is more likely, a kick and a snare taking turns says that is the beat people clap to, and a kick between the beats says the beat is faster. When the tempo could just as well be half or double, it says so.
3. Tracks the beats with dynamic programming (Ellis's method, as in librosa), moves each onto its onset, and fits them to one steady line when the tempo holds.
4. Finds the bar lines from where the kicks, the chord changes and the changes in loudness fall, and whether a bar has three beats or four.
5. Describes every bar by its harmony, timbre, loudness and rhythm, finds where sections change, the drop (the first time the track reaches its fullest after a quieter stretch, on a phrase line) and how the track ends.
6. Lays the result out as slots one bar long, lined up so a slot starts exactly on the hit, and fills them with bars of the track by dynamic programming: playing on costs nothing, a seam costs more the less its two sides sound like bars that follow each other in the track, and more again when it breaks a four-bar phrase or leaves a build before its drop.
7. Joins the bars with short crossfades, lines up the hits at every seam, fades the head and the tail, ducks the voice, sets the loudness, and writes the files.

## Limits

- One hit per run. A second moment that must land on a beat can use the bar frames in `cues.json`.
- The tempo can be read as half or double the real one, the main failure of beat tracking. musicfit warns when both are likely and then cuts only in pairs of bars, which stays on the bar lines either way; `--bpm` settles it.
- When nothing in a track marks the first beat of the bar, the bar lines can come out a beat off. musicfit says when it is unsure, and the cuts still keep the beat, since they skip whole bars.
- A groove whose loudest hits fall between the beats over a sparse kick, as in some dembow and afrobeats patterns, can be read half a beat off without a warning. Listen to the first seam.
- Tracks with no steady beat (ambient, rubato piano) are joined with one-second crossfades where they sound alike, not on bar lines. Listen to every seam.
- A tempo that changes a lot within the track, or a bar of 2/4 in a 4/4 song, can put a seam a beat off.
- Seams follow bars and sound, not words: in a song with singing a cut can fall in the middle of a line. An instrumental fits best.
- Lengthening loops bars the track already has, so a 30 second track stretched to 3 minutes repeats, and so does the intro when the drop is asked for much later than the track has it (musicfit says how many times). Ask the music model for a little more than you need.
- It does not change the tempo or the pitch, and it does not check whether you may use the track.

## See also

- [launch-film](https://github.com/EminBudak/launch-film) turns a site into a short launch film, rendered on your machine.
- [easyscreenshotkit](https://github.com/EminBudak/easyscreenshotkit) saves clean screenshots of a website's pages.
- [easybrandkit](https://github.com/EminBudak/easybrandkit) saves a site's real logo files, colors and fonts as a brand kit.

## License

MIT
