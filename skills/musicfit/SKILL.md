---
name: musicfit
description: Fit a music track to a video and lay it under the video, such as a launch film, a product demo, an ad, a reel or a Remotion or HyperFrames composition. Makes the track exactly as long as the cut by cutting or looping whole bars, lands its drop on a chosen second, ends it with a fade that resolves on a beat, ducks it under a voice-over, sets its loudness, writes every beat and bar as frame numbers, and with the video given writes the video with the track under it. Use it whenever a track (from a music model, a library or the user) has to fit a video's length, has to go under a finished video, or the cuts should land on the beat.
---

# musicfit

Music models ignore the length you ask for, and a track cut at the video's last frame stops mid-bar. musicfit edits the track the way a music editor would: it finds the beats and bar lines, cuts or loops whole bars where they sound alike, puts the drop where the video needs it and lets the music end on a beat.

## Fit a track

```bash
node <skill>/scripts/musicfit.js track.mp3 --length 32 --hit 27.5 --fps 30 --out audio/fit
```

`<skill>` is this skill's folder. The script needs Node 22 or newer and ffmpeg 4.4 or newer on the machine; it installs nothing and needs no API key. A run takes a few seconds.

- `--length` is the video's length: seconds (`32`), frames (`960f`, at `--fps`) or minutes (`1:05`).
- `--hit` is the second the drop should land on, for example the logo reveal. Leave it out and the track starts as it starts and ends on its own ending.
- `--drop 41.3` says where the drop is in the track when the one found is not the one you want. `--analyze` lists the candidates first.
- `--voice vo.wav` ducks the music under a voice track laid out on the video's timeline and also writes `mix.wav`.
- `--video film.mp4` also writes `video.mp4`: the video's picture as it was, copied and not encoded again, with the fitted track under it at the loudness target. The video has to be `--length` long to a frame; without `--fps` the frames count at its frame rate. `--video-sound` says what becomes of the video's own sound, and a video with more than a faint room tone of its own is refused until it is given: `keep` for sound effects (they stay, turned down to the loudness target if they are louder, and the music dips half of `--duck`, 5 dB, under them), `voice` for speech (set to the loudness target, and the music dips `--duck`, 10 dB, under it), `drop` for music of its own (left out). The whole is then set to the loudness target, so a kept sound can come out a few dB louder or quieter than in the video. When you do not know what the video's sound is, ask the user. For a launch film from launch-film that should carry your own track, make or plan the film with `--no-music`, or set `"music": false` in its film.json and render it again, so its sound is its effects only; then give its film.mp4 here as `--video` with `--video-sound keep`.
- `--fps` should match the composition, so the frame numbers in `cues.json` can be used as they are.
- `--analyze` saves in `musicfit-<track name>.analysis` by default, never in a fit's folder unless you give both the same `--out`.

## Use the result

1. Read `audio/fit/FIT.md` first. It says what was cut or looped and lists the moments a person should listen to, with their frames.
2. Show `seams.png` to the user: the track on top, the fitted result below, every seam and the hit marked.
3. With `--video`, hand over `video.mp4`: that is the video with the track under it. Without it, put `fitted.wav` (or `mix.wav` with a voice) under the whole video, starting at frame 0, and do not trim or stretch it: it is already exactly `--length`. Never say the track is in the video before a file with it exists.
4. Time the edit to the music with `cues.json`: `beats` and `bars` are frame numbers at `--fps`, `hits` the frames of the drop and of the track's own last hit, `sections` where the music changes, and `times` has the same moments in seconds. In Remotion that is `<Sequence from={cues.bars[8]}>`; cut scenes on bar frames, small moves on beats.
5. Tell the user to listen at the seams and the hit before the film goes out. `FIT.md` lists them with their frames.

## When it goes wrong

- A warning that the tempo could be half or double means the bar lines may be off. If the seams sound like they skip, run again with `--bpm` set to the other tempo.
- "No steady beat" means the track is ambient or free; musicfit then joins its parts with one-second crossfades where they sound alike. Listen to every seam.
- If the drop it picked is the wrong one, run `--analyze` and pass `--drop` with one of the candidates in `cues.json` (`source.dropCandidates`).
- A note that some bars play several times means `--hit` is much later than the track's own drop, so its intro repeats. Suggest an earlier `--hit`, or `--drop` with a later candidate.
- With no steady beat, `beats` and `bars` in `cues.json` are empty lists. Time the edit by `hits` and `seams` instead.
- The track can come from any music model. Ask for an instrumental a little longer than the video: musicfit shortens more gracefully than it lengthens, and its seams follow bars, not sung words.
- `--video` refuses before any work a video it cannot read, one that is cut short or damaged, one with no picture, one whose picture an MP4 cannot hold without encoding it again (ProRes, DNxHD, VP8: ask for an H.264 or HEVC copy), one that is not `--length` long (the message gives the length to use), and a video musicfit made unless `--video-sound drop` leaves its sound out (else give the video it was made from).
- A video with sound of its own is refused until `--video-sound` is given: ask the user whether that sound is sound effects to keep (`keep`), speech (`voice`) or music of its own (`drop`). Read the notes in the summary too: one says when the video's own sound plays for most of its length.
- A run is refused before any work when its out folder holds a file under one of musicfit's names that musicfit did not write (move it, or give another `--out`), or when the track, the voice or the video is one of the files the run would replace or remove.
- A run that fails or is stopped leaves its folder as it was, so a fit that worked is never lost to one that did not. A run killed outright after it began writing can leave a hidden `.musicfit-part-` folder, which a later run that ends well in the same place removes once the killed run's process is gone and 15 minutes have passed. When another program held a file open so that a run could not put every earlier file back, the message names the folder they are in, and its `musicfit-kept.txt` says where each one belongs: tell the user.
- Never say a track is cleared for use; musicfit does not check rights.
