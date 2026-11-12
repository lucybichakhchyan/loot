# Changelog

Each deployed version has a git tag, such as `v0.1.0`. The newest version is listed first.

## v0.1.1, 12 Nov 2026

- Each video on the home page has a delete button. A confirmation appears before anything is removed.
- The deploy script no longer copies unfinished design files to the live site. That copy now runs only when you set `SYNC_DESIGN=1`, and the upload leaves out the `.git` folder.

## v0.1.0, 12 Nov 2026

- First version. Record the screen and camera, cut a recording by editing its transcript, get cut suggestions from Claude, export an MP4, and run the background jobs with Swamp.
- Added the MIT licence, this changelog and the README.
