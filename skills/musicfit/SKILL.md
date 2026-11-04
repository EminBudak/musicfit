---
name: musicfit
description: Fit a music track to a video before you put it under the video, such as a launch film, a product demo, an ad, a reel or a Remotion or HyperFrames composition. Makes the track exactly as long as the cut by cutting or looping whole bars, lands its drop on a chosen second, ends it with a fade that resolves on a beat, ducks it under a voice-over and sets its loudness, and writes every beat and bar as frame numbers. Use it whenever a track (from a music model, a library or the user) has to fit a video's length, or the cuts should land on the beat.
---

# musicfit

Music models ignore the length you ask for, and a track cut at the video's last frame stops mid-bar. musicfit edits the track the way a music editor would: it finds the beats and bar lines, cuts or loops whole bars where they sound alike, puts the drop where the video needs it and lets the music end on a beat.

## Fit a track

```bash
node <skill>/scripts/musicfit.js track.mp3 --length 32 --hit 27.5 --fps 30 --out audio/fit
```

`<skill>` is this skill's folder. The script needs Node 22 or newer and ffmpeg on the machine; it installs nothing and needs no API key. A run takes a few seconds.

- `--length` is the video's length: seconds (`32`), frames (`960f`, at `--fps`) or minutes (`1:05`).
- `--hit` is the second the drop should land on, for example the logo reveal. Leave it out and the track starts as it starts and ends on its own ending.
- `--drop 41.3` says where the drop is in the track when the one found is not the one you want. `--analyze` lists the candidates first.
- `--voice vo.wav` ducks the music under a voice track laid out on the video's timeline and also writes `mix.wav`.
- `--fps` should match the composition, so the frame numbers in `cues.json` can be used as they are.

## Use the result

1. Read `audio/fit/FIT.md` first. It says what was cut or looped and lists the moments a person should listen to, with their frames.
2. Show `seams.png` to the user: the track on top, the fitted result below, every seam and the hit marked.
3. Put `fitted.wav` (or `mix.wav` with a voice) under the whole video, starting at frame 0. Do not trim or stretch it: it is already exactly `--length`.
4. Time the edit to the music with `cues.json`: `beats` and `bars` are frame numbers at `--fps`, `hits` the frames of the drop and of the track's own last hit, `sections` where the music changes, and `times` has the same moments in seconds. In Remotion that is `<Sequence from={cues.bars[8]}>`; cut scenes on bar frames, small moves on beats.
5. Tell the user to listen at the seams and the hit before the film goes out. `FIT.md` lists them with their frames.

## When it goes wrong

- A warning that the tempo could be half or double means the bar lines may be off. If the seams sound like they skip, run again with `--bpm` set to the other tempo.
- "No steady beat" means the track is ambient or free; musicfit then joins its parts with one-second crossfades where they sound alike. Listen to every seam.
- If the drop it picked is the wrong one, run `--analyze` and pass `--drop` with one of the candidates in `cues.json` (`source.dropCandidates`).
- The track can come from any music model. Ask for an instrumental a little longer than the video: musicfit shortens more gracefully than it lengthens, and its seams follow bars, not sung words.
- Never say a track is cleared for use; musicfit does not check rights.
