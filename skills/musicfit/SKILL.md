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

`<skill>` is this skill's folder. The script needs Node 22 or newer and ffmpeg 4.4 or newer on the machine; it installs nothing and needs no API key. A run takes a few seconds, and with a long `--video` a minute or more. A long fit needs memory, more the longer the fit and the longer the track: a 10 minute fit of a 10 minute track took 0.9 to 1 GB, 1.2 GB with `--video`, 1.4 to 1.5 GB with `--voice` and 1.7 GB with a voice and the video's own sound.

- `--length` is the video's length: seconds (`32`), frames (`960f`, at `--fps`) or minutes (`1:05`).
- `--hit` is the second the drop should land on, for example the logo reveal. Leave it out and the track keeps its own ending; a short fit can then start later in the track, so its drop may not play (FIT.md says where it starts). Give `--hit` when the drop has to be heard.
- `--drop 41.3` says where the drop is in the track when the one found is not the one you want. `--analyze` lists the candidates first.
- `--voice vo.wav` ducks the music under a voice track laid out on the video's timeline and also writes `mix.wav`.
- `--video film.mp4` also writes `video.mp4`, the video with the fitted track under it: see the next section.
- `--fps` should match the composition, so the frame numbers in `cues.json` can be used as they are.
- `--analyze` saves in `musicfit-<track name>.analysis` by default, never in a fit's folder unless you give both the same `--out`. An analysis given a fit's `--out` replaces that fit when it ends well: `fitted.wav`, `mix.wav` and `video.mp4` are removed. Give `--analyze` its own folder, or leave `--out` out.

## Lay it under a video

`--video film.mp4` also writes `video.mp4`: the video's picture as it was, copied and not encoded again, with the fitted track under it at the loudness target. The video has to be `--length` long to a frame; without `--fps` the frames count at its frame rate.

A video with more than a faint room tone of its own, a single click included, is refused until `--video-sound` says what becomes of that sound. When you do not know what it is, ask the user:

- `keep` for sound effects: each place where it plays is set 3 dB louder than the music there, and no quieter than the loudness target, so a place over quiet music or none plays at the target; it goes no louder than keeps its true peaks, with the music's, under -1 dBTP, so the limiter takes nothing off the music. Where that leaves a place less than 3 dB over the music, as a sharp sound or one on a loud drop can be, the music dips under that place alone by as much as is missing, `--duck` (10 dB) at most, and plays as in `fitted.wav` elsewhere; a note names a place that stays short even so. `video.mp4` can then come out under the target, more at a loud `--lufs`; a note says so when it is more than half a LU short. In a launch film whose own sound was five effects, the logo sound on the drop came out 3.4 dB over the music with the music 7.7 dB down under it, and the film at -14.4 LUFS. With `--voice` as well, the music dips under the voice as it always does and each place is set over that music, so one the voice speaks over plays at the target, as loud as the voice, with no further dip; where a place meets the voice a limiter holds the two under -1 dBTP and `video.mp4` reaches the target.
- `voice` for speech: set to the loudness target where it speaks, and the music dips `--duck` (10 dB) under it, in `fitted.wav` and `mix.wav` too. With no speech found in it, it is only turned down if it is louder than the target, and a note says so.
- `drop` for music of its own: left out.

A voice the video already holds goes with `--video-sound voice`, not as a copy given to `--voice`, which would lay it in twice. For a launch film from launch-film that should carry your own track, make or plan the film with `--no-music`, or set `"music": false` in its film.json and render it again, so its sound is its effects only; then give its film.mp4 here as `--video` with `--video-sound keep`.

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
- `--video` refuses before any work a video it cannot read, one that is cut short or damaged, one with no picture, one whose picture an MP4 cannot hold without encoding it again (ProRes, DNxHD, VP8: ask for an H.264 or HEVC copy), one that is not `--length` long (the message gives the length to use), and a video musicfit made unless `--video-sound drop` leaves its sound out (else give the video it was made from, which the message names when the video's `cues.json` is beside it).
- A video with sound of its own is refused until `--video-sound` is given: ask the user whether that sound is sound effects to keep (`keep`), speech (`voice`) or music of its own (`drop`). Read the notes in the summary too: one says when the video's own sound plays for most of its length, and with `keep` one names each place where that sound stays less than 3 dB louder than the music even with the music dipped `--duck` under it, as a sharp sound over the loudest part of the track can. Tell the user; a larger `--duck` lets the music dip further there, and deepens its dip under the `--voice` too when there is one, so no note suggests it then.
- A note that `video.mp4` is short of the loudness target, or over -1 dBTP after the AAC encoding, says how it came out; FIT.md says the same. Tell the user.
- A run is refused before any work when its out folder holds, under a name the run writes, a file that is not as an earlier musicfit run wrote it there, such as the user's own `video.mp4` beside a copied `cues.json` for a run with `--video`, or a `FIT.md` or `cues.json` the user changed (move it, with the files it lists for a `cues.json`, or give another `--out`); a run that does not write that name leaves the file alone. It is refused too when the track, the voice or the video is one of the files the run would replace or remove.
- A run that fails or is stopped (Ctrl-C, or a signal such as SIGTERM) leaves its folder as it was, so a fit that worked is never lost to one that did not. As the earlier files stay until the new ones are in place, a run needs room on the disk for both, and a full disk says so. A run that ends well removes the earlier files it does not make again, and a note names them: tell the user when one was a fit's `video.mp4` or `fitted.wav`. A run killed outright after it began writing can leave a hidden `.musicfit-part-` folder, inside the out folder or next to it when the out folder was not there yet, which a later run that ends well in the same place removes once the killed run's process is gone and 15 minutes have passed; a run killed in the moment it moved its files in is undone by the next run there, which puts the earlier files back first, and no other run removes its hidden folder. When a failed or stopped run could not remove its hidden folder, its message names it, and a later run removes it the same way. When another program held a file open so that a run could not put every earlier file back, the message names the folder they are in, and its `musicfit-kept.txt` says where each one belongs: tell the user.
- musicfit reads files: a track, a voice or a video given as an address is refused. Download it first.
- Never say a track is cleared for use; musicfit does not check rights.
