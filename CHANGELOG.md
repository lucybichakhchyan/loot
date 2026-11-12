# Changelog

Each deployed version has a git tag, such as `v0.1.0`. The newest version is listed first.

## v1.0.0, 12 Nov 2026: first full version

- Shorts: Claude suggests the parts of a long video that work on their own. You can keep, trim and download each one as an upright 1080 by 1920 video with captions.
- Share links: a link lasts 1, 7 or 30 days, or until you turn it off, and the viewer's page shows your brand. You can also copy a GIF of the first 3 seconds into an email.
- Share now: the recorder gives you a link straight after recording, and the video is prepared and exported in the background.
- Brand settings: you set your name, logo, colors, fonts, caption style, closing line and share page button once. Exports, the editor and the share page all use them.
- Editor: there is one Add menu, blur for the screen recording, text and image overlays, crop, and layout changes with a cut or a smooth fade. Claude writes YouTube chapters, the timeline has a zoom slider, and a zoom points at the spot you click on the video.
- Recorder and home: the floating controller has a Script button, the Camera menu has Mirror my camera, and a notice appears when the microphone is quiet. Home shows upload progress, a Sign out button and how many days each video has left on the server.
- Copy buttons work in Chrome, Safari and the Claude app's browser pane.
- Anyone can fork LOOT and run their own copy. Nothing personal is built into the code, the web address and time zone come from `.env`, the deploy script reads its server and folder from settings, and the README explains the setup.
- The approved design mockups are included in `design/`.

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
