# TextCache privacy policy

Last updated: 16 November 2026

TextCache is a browser extension that keeps a copy of what you type into text areas and rich-text editors, so you can get the text back after a page
crashes or a form is lost. This policy describes what it stores and what it does not do.

## What TextCache stores

When you type into a multi-line text area or a rich-text editor on a web page, TextCache saves, in your browser's local extension storage:

- the text you typed (for rich-text editors also its formatting, as HTML),
- the address and the title of the page,
- when the text was first saved and last changed.

It also stores your TextCache settings.

TextCache never saves `<input>` fields, so it does not save passwords or the usual login forms. It does save every multi-line text area and
rich-text editor, which includes some fields that look single-line, such as the search box of some search engines. For text typed into an embedded
frame (some editors run in one), the frame's own address and title are stored.

It saves nothing on pages, or in embedded frames, whose own address contains an entry of the "Pages to skip" list in its settings. Empty fields are not
saved.

## What TextCache does not do

- It sends nothing anywhere. The extension makes no network requests of its own: no servers, no analytics, no tracking, no advertising.
- It does not use browser sync; the saved texts stay on the device and in the browser profile where they were typed.
- It does not sell, share or transfer your data to anyone, and it does not use it for any purpose other than letting you see, copy and recover what
  you typed.
- TextCache's use of the data it handles complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Your control over the data

- You can read, copy and delete saved texts at any time in the extension's popup and in its full list.
- By default, automatic clean-up keeps the 100 most recent saved texts and deletes older ones; you can change the number or switch it off.
- By default, when the same text is saved more than once, the older copies are deleted; this has its own switch in the settings.
- "Delete all saved texts" in the settings removes them at once.
- "Export CSV" writes a file with your saved texts to your computer, only when you ask for it.
- Removing the extension from the browser deletes everything it stored.

## Permissions

- Access to all websites: needed to notice typing in text areas and editors on whatever page you use.
- `storage` and `unlimitedStorage`: to keep the saved texts and settings on your device without the browser's 10 MB limit for extensions.
- `alarms`: to run the automatic clean-up once an hour.
- `clipboardWrite`: for the "Copy" buttons.
- `activeTab`: so the popup can filter the saved texts to the site of the tab you are on when you open it.

## Contact

Questions and reports: https://github.com/navara/textcache/issues
