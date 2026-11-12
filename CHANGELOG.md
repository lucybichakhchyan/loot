# Changelog

Each deployed version has a git tag, such as `v0.1.0`. The newest version is listed first.

## v0.2.0, 12 Nov 2026

- Sound: noise removal is gentler, volume is levelled to YouTube's level, and clean-up falls back to the original when it would remove the voice. The microphone meter now says "very quiet" when the sound is too low.
- Speed: each clip is prepared in the background as soon as it uploads, so the editor opens sooner.
- The camera is mirrored by default, and a "Mirror my camera" switch turns that off.
- The home page and the recorder are rebuilt from the approved design. Each video has a menu with Rename and Delete, and Delete can be undone. Clips can be watched, retaken and deleted, and the recorder has a floating controller.
- The editor is rebuilt from the approved design. It has one undo history, a review step for mistakes with "Hear it" and "Fix text", layouts for part of a video, zooms, clip trimming, real splitting, title and closing cards, and a new export flow with progress, cancel and a finished view.
- Claude writes a title and description for each video from its transcript.
- The export engine supports layouts per part, zooms, cards, fixed words and cancel. It fixes exports that stalled when a long stretch was cut, and a 90-second watchdog stops any export that hangs.

## v0.1.1, 12 Nov 2026

- Each video on the home page has a delete button. A confirmation appears before anything is removed.
- The deploy script no longer copies unfinished design files to the live site. That copy now runs only when you set `SYNC_DESIGN=1`, and the upload leaves out the `.git` folder.

## v0.1.0, 12 Nov 2026

- First version. Record the screen and camera, cut a recording by editing its transcript, get cut suggestions from Claude, export an MP4, and run the background jobs with Swamp.
- Added the MIT licence, this changelog and the README.
