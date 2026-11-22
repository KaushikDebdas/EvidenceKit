# EvidenceKit (v1.0.0)

Works in Chrome, Microsoft Edge and Brave (tested on version 157), on any screen size. Install:
1. Unzip this folder.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. Click **Load unpacked** and select the `EvidenceKit` folder.
4. Pin the extension icon.

## Screenshots
- **Visible**: what you see now.
- **Full page**: scrolls and stitches the whole page (up to 16 000 px). On app-style pages where the page itself does not scroll (Outlook, OneDrive, Teams, Gmail …), it finds the main scrolling area (mail list, file list) and stretches it to its full length, with the header and sidebars in place. For another list on the same page, use **Scroll box**.
- **Area**: drag a rectangle. The page is frozen first, so open dropdowns, tooltips and hover menus stay in the picture.
- **Element**: hover a button, card or table and click it. Arrow Up/Down picks the parent/child element. Elements taller than the screen are captured in full.
- **Dual select**: select two areas and get them in one image. You can scroll with the mouse wheel between the first and second area.
- **Split view**: tick 2–6 tabs (from any window) and get them side by side in one image; your current tab, and the current tab of every other open window, are ticked for you. Each pane gets its own URL bar. The keyboard shortcut uses the current tab of each window (with one window: this tab and the one you used just before).
- **Scroll box**: a list, table, chat or frame (also from another site) that scrolls up/down, sideways or both is scrolled and captured in full. Sticky header rows and frozen columns appear once, not in every piece.
- **Mobile view**: the page at iPhone, Pixel, iPad, laptop or custom size. The browser window is resized for a moment and then put back, so there is no "debugging" bar. Layout changes like on the device, but it is not a full phone emulation. Below 500 px, Chrome cannot make its window that narrow, so the page opens in a small extra window for the capture.
- **Screen / app**: a screenshot of the whole desktop or another program window.
- **Open image**: annotate a picture from your computer or the clipboard.
- **Last capture**: reopen the latest screenshot in the editor.
- **Delay** (Off / 3 / 5 / 10 s) in the popup: open a menu while the countdown runs.

Every screenshot can carry a browser-style bar with the page URL and the real date and/or time.
- Choose **Date and time**, **Date only** or **Time only** (popup chips, Settings, or the editor).
- **Date format**: 2026-11-20, 20-11-2026, 20/11/2026, 11/20/2026, 20 Nov 2026 (default), Nov 20, 2026, or a custom pattern.
  - Tokens: `DD` 05, `D` 5, `MM` 11, `M` 11, `MMM` Nov, `MMMM` November, `YYYY` 2026, `YY` 26.
  - Text inside `[ ]` is kept as it is, for example `[Date:] DD/MM/YYYY`.
- 12-hour clock with AM/PM by default (24-hour available), for example `20 Nov 2026 03:04:05 PM`.
- **Bar size**: Small, Medium, Large or Extra large.
- Console / Network panels can be switched on in the popup before you capture.

After capture you can: open the editor, save, save + edit, copy, copy + save, or add the image to the User Manual.

## Editor
All tools are in the bar at the top. The buttons on its right open the **URL & Time**, **Frame**, **Info** and **Logs** panels.
- **Tools**: arrow, box, oval, line, pen, text (plain, white box, color label or outline), step numbers, QA stamps (PASS / FAIL / BUG / BLOCKED / FIXED / NOTE / ✓ / ✗ / ? / !), highlight box, marker, spotlight, magnifier, blur, redact, eraser and crop.
- **Style options**: color swatches, eyedropper, size, dashed lines, fill and opacity.
- **QA stamps**: you can change the size, color and text before or after placing a stamp. **Custom** takes your own text. Select a stamp and click another preset to swap it, or press ↺ to go back to its own color.
- **Frame**: a gradient or solid background with padding, rounded corners and a shadow.
- **Saving**: PNG, JPG, WebP or PDF, or copy + save, with an editable file name.
- **Pasting**: paste or drop another image onto the screenshot.
- **Theme**: light by default, dark from the moon button or Settings (also used by the popup and recorder). Press `?` to see every shortcut.

## Screen recorder
- Record a browser tab, an app window or the entire screen, in MP4 or WebM at 720p / 1080p / 1440p / 4K and 30 / 60 fps.
- **Audio**: tab or system sound, plus a microphone with a level meter. You can mute the mic while recording.
- **Camera bubble and floating controls**: they stay on top of other windows, and the camera shows in window and screen recordings.
- **During recording**: a countdown before the start, click ripples, and pause / resume.
- **Repro steps** (optional): each click and typed field becomes a step with its time in the video.
  - **Tab recording**: steps come from the tab you started from.
  - **Entire screen / window recording**: steps also come from:
    - clicks in **any Chrome tab**;
    - **opening or switching tabs**, for example a PDF report that opens in a new tab;
    - **switching to another program** (Excel, Edge …) and back.
  - In an entire screen or window recording, each step's picture is taken **from the screen video**, so it shows what was really on the screen, including other programs. On an entire-screen recording the click is outlined in the picture.
  - A browser extension cannot see clicks *inside* other programs. While another program is in front, a big change of the screen that then stays still becomes a step ("The screen changed"). You can also press **📸 Add step now** in the recorder or in the floating controls. A third way is the shortcut "Screen recorder: add a step now" (set it at `chrome://extensions/shortcuts`, scope *Global*, so it works in any program).
  - A screenshot for each step and the typed values are both optional. Passwords are never written.
  - Steps can be copied, downloaded (Markdown, or a ZIP with images), or added with **Add to Manual** / **Add to Test Evidence**.
- **URL, date and time on step pictures**: Step guide and repro-step pictures get the same URL / date / time bar as screenshots (popup → "Add to image"). Pictures from another program show the date and time only.
- **Review**: preview the video, rename it, download it, open a frame in the editor, trim it, or export an animated **GIF** (max 30 s, 800 px wide, 10 fps).
- WebM files get a proper duration, so they can be seeked in any player.
- Trim, GIF and Frame need the browser to decode the recording. If Chrome cannot decode an MP4 it made, you will see a message and the file can still be downloaded. Choose **WebM** in Quality & options if you trim or make GIFs often: it works every time.

## User Manual
- **Sections**: split the manual into flows such as "Registration" and "Login". Press **New section here** (list icon) on the first step of a flow (or **＋ Section** at the end) and type its name. Step numbers start at 1 in every section. Move a step with ↑ ↓ across a heading to change its section; **Remove heading** keeps the steps. Every screen recording and step guide you add starts its own section, which you can rename.
- **Export one section or the whole manual**. The table of contents is grouped by section.
  - **Word (.docx)** is the main export. It is a real Word document with the pictures inside, A4, with page numbers. It also opens in Google Docs and LibreOffice.
  - PDF (print), HTML and Markdown are also available.
- Step titles and descriptions are suggested automatically from what was clicked or captured. The rules run on your computer, with no AI and no server. Press ✨ to suggest again.
- **Branding**: your logo, a brand color and a table of contents. All of them go into the PDF, HTML, Markdown and Word exports.
- **Edit image**: opens the editor right inside the manual. Press "Save to step" and the image updates.

## User Manual and Test Evidence are separate
They are two separate documents. You choose where something goes each time you add it, with two buttons: **＋ User Manual** and **＋ Test Evidence**. Press both to add it to both.
- **After capture → Add to Manual / Test Evidence**: after each screenshot, a message on the page shows the two buttons. Nothing is added until you press one.
- **Step guide**: the recorded steps wait until you choose.
  - When you press Finish, the manual page shows the recording with **＋ User Manual / ＋ Test Evidence / Both / Discard**.
  - If the tab was closed, the recording still waits there, and the popup's book icon shows a red **!**.
  - In the Test Evidence, the recording becomes a test case.
- **Screen recorder** (repro steps) and the **editor** each have both buttons too.
- The switch at the top of the manual page only chooses which document you look at.
- **⇄ To Test Evidence / To User Manual** on a section heading moves that section and its steps to the other document.
- **Clear all** empties only the document you are looking at.
- Steps made before this change are in the User Manual.

## Test Evidence
Switch the manual page from **User Manual** to **Test Evidence** (top bar). Every section of the Test Evidence is a **test case**.
- Each test case has an ID (TC-01, TC-02 … automatically, or your own), Pass / Fail / Blocked / Not run, a bug ID, a precondition, and the **expected and actual result**.
  - You write these once per test case, not for every click. A recorded flow (login, open the form, fill it in, save) gives many steps, and they are simply listed as the test steps.
  - Leave the actual result empty on a passed test case and the export says "As expected."
- **◎ Checkpoint**: mark a step where you verify something (for example "Asset saved" appears). Only that step gets its own expected / actual result and Pass / Fail.
- At the top, fill in the project / module, ticket, build, environment, tester and date. A summary counts the passed, failed, blocked and not-run test cases.
- **Screenshots** in the export: all steps, only the checkpoints + the last step of each test case, or none.
- Export to Word (.docx, the main button), PDF, HTML or Markdown. The document starts with a summary table (TC ID, test case, status, bug ID), followed by every test case with its steps and pictures.
- A step guide recorded while Test Evidence is on starts a section called "Test case — <date>".

## Backup and restore
- **⬇ Backup** (manual page) saves everything into one `.zip`: every step and section with all pictures, the expected / actual results, the title, logo, colour, evidence details and the settings.
- **⬆ Restore** loads such a file, on this or another computer:
  - **Replace** puts the backup in place of the current manual.
  - **Add** appends it after the current steps.
  - Settings are restored only if you tick the box.
- Screenshots kept for 24 hours ("Last capture") are not part of the backup. A folder chosen in Settings → Saving must be chosen again on another computer.

## Shortcuts
Change them at `chrome://extensions/shortcuts`.
- Alt+Shift+S: visible area
- Alt+Shift+A: select area
- Alt+Shift+F: full page
- Alt+Shift+G: start / stop the step guide

Element, Dual select, Scroll box, Split view, Delayed capture and Screen recorder have no default key. Chrome gives at most 4 default keys, so you can assign them yourself on that page.

## Storage and privacy
- Screenshots are kept in the browser for 24 hours (for the editor and "Last capture"). **Settings → Shortcuts & data → Delete temporary screenshots now** removes them at once. That page also shows how much space EvidenceKit uses.
  - These temporary screenshots are not part of the User Manual / Test Evidence, so **Clear all** on the manual page does not remove them.
- Saved files go to `Downloads/QA-Evidence/`, or to **any folder you choose** (Settings → Saving → "A folder I choose").
  - This covers screenshots, recordings, GIFs and repro steps.
  - If Chrome asks for permission again (for example after a restart), files go to Downloads until you press "Allow access again".
  - Brave turns folder picking off, so in Brave files always go to Downloads.
- Console and network logs are recorded by a small script in each web page. Turn off **Settings → Logs → Capture logs automatically** and the script no longer runs in any page (reload open tabs once).
- Everything stays on your computer. There is no account and no server.

## Step numbers and editing in the User Manual (update)
- **Numbers follow the steps.** Steps from the Step guide and from recording Repro steps keep a clean copy of the screenshot. When you delete, move or split steps, the click number on every picture is redrawn automatically to match the Step number shown in the manual (also in the PDF / HTML / Markdown / Word exports).
- **Annotations stay editable.** *Save to step* now keeps your arrows, boxes, stamps, badges and text as layers. Press **Edit image** again and everything can still be moved, changed or deleted.
- **The click marker is editable too.** Inside the editor the click outline and its number are normal objects. Its number keeps following the Step number until you change it by hand (double-click the badge).
- **Your own numbered badges.** *Delete* a badge and the others close the gap (1, 2, 3 …). Use **↻ Renumber** in the badge options at any time. Double-click a badge to type another number.
- Steps made **before** this update have no clean copy, so they keep their old numbers. Record them again to get automatic numbering.
- A step saved with the **Frame** option on keeps its number as it was.
- **Clear messages.** Saving, copying or adding to the manual — in the popup, the editor and the screen recorder — now shows a big green message with a title (and an **Open User Manual** button). It closes by itself after 3 seconds, or press ✕. The editor button is now **Add to Manual**. In the manual, newly added steps glow green with a NEW tag and the page scrolls to them.
