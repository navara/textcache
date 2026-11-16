# Chrome Web Store submission texts

Drafts to paste into the Developer Dashboard for the first submission (the API cannot fill these in). Field names follow Google's dashboard docs as read on
2026-11-16; the category name and the exact data-usage labels are assumed (check them in the dashboard).

## Package

Upload `dist/textcache-<version>-store.zip` from `npm run pack:store`: the files at the zip's root, the manifest without its `key`.

## Store listing tab

**Description:**

> TextCache keeps a copy of what you type into text areas and rich-text editors, so a crashed tab, an expired session or an accidentally closed form
> no longer costs you what you wrote.
>
> • Saves while you type, in comments, forum replies, mail and support forms, wikis, chat editors and any other multi-line field
> • Finds any saved text by words from it, its page address or title
> • Copies the text back with one click, also with its formatting from rich-text editors
> • Can show only the texts saved on the site you are on, right from the toolbar button
> • Never saves input fields such as passwords and logins, nor search boxes; skips the sites you list
> • Keeps the newest texts and cleans up older ones automatically; removes duplicate copies of the same text
> • Exports everything as CSV
> • Available in English, Čeština, Deutsch, Español, Français, Português (Brasil), Українська, 简体中文, 日本語, हिन्दी and العربية
>
> Everything stays in your browser. TextCache makes no network requests, uses no servers, analytics or tracking, and does not sync your texts.
>
> Free software under the GNU GPL. Source code: https://github.com/navara/textcache

**Category:** Tools (under Productivity)

**Mature content:** No

**Language:** English

**Store icon:** taken from the package (`icons/icon-128.png`).

**Screenshots** (1280 × 800, rendered by `node store/shots.cjs`, in this order):

1. `screenshots/1-list.png`: the list of saved texts with one open.
2. `screenshots/2-list-dark.png`: a formatted text in dark mode.
3. `screenshots/3-search.png`: searching the saved texts.
4. `screenshots/4-settings.png`: the settings.

**Homepage URL:** https://github.com/navara/textcache

**Support URL:** https://github.com/navara/textcache/issues

## Privacy tab

**Single purpose:**

> TextCache saves what the user types into multi-line text fields on web pages, locally in the browser, so the user can recover the text after a page
> crash or a lost form.

**Permission justifications:**

- **Host permission (content script on all sites and frames):** The content script notices typing in text areas and rich-text editors on whatever page
  the user writes on, which can be any site. It also runs in frames, including about:blank ones, because many rich-text editors (mail, CMS, forum
  editors) live inside an iframe. It reads the field being typed into plus the page's address and title, and saves them locally; it changes nothing on
  the page and sends nothing anywhere.
- **storage:** Keeps the saved texts and the settings in the browser's local extension storage.
- **unlimitedStorage:** Lifts the 10 MB limit of local extension storage, so saving does not stop silently once many or long texts are kept. Automatic
  clean-up still limits how many are kept.
- **alarms:** Runs the automatic clean-up (keep the newest saved texts, remove duplicate copies) once an hour.
- **clipboardWrite:** Puts a saved text on the clipboard when the user presses a Copy button.
- **activeTab:** When the user opens the popup, reads the address of the current tab so the popup can show the texts saved on that site.

**Remote code:** No, I am not using remote code.

**Data usage**, collected or handled (stored locally only, never transmitted):

- [x] Website content (the text typed into fields on web pages)
- [x] Web history (the address and title of the pages where text was saved)
- [x] Personal communications (typed mail, chat and forum messages are saved)
- [x] Personally identifiable information (whatever the user types, such as names or addresses in a form, is saved)
- [ ] User activity, Authentication information: your call. TextCache saves field contents, not keystrokes, clicks or mouse movement, and never saves
  `<input>` fields, so passwords are only saved if typed into a text area or editor. Ticking them is the cautious choice; Google rejects for
  under-disclosure, not for over-disclosure.
- [ ] Health, Financial and payment, Location: no.

**Certifications** (all three apply):

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://github.com/navara/textcache/blob/main/PRIVACY.md

## Distribution tab

- **Payments:** Free of charge.
- **Visibility:** Unlisted (only people with the link can install it). The API can publish later versions only with the visibility of the last manual
  publish.
- **Distribution:** all regions.

## Test instructions tab

Written in Simplified Technical English, 451 of the 500 characters the field allows. Checked on 2026-11-16: text typed into pastebin.com is saved.

```text
No account is necessary.
1. Open https://pastebin.com/.
2. Type two lines in the text field.
3. Close the tab.
4. Click the TextCache icon in the toolbar. The popup shows the text.
5. Click "Copy". The clipboard contains the text.
6. Click "Open full list". The full list shows the text.
7. In the search field, type one word of the text. The list shows only that text.
TextCache does not save password fields or search boxes. TextCache sends no data.
```
