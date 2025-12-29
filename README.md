# ChatGPT Chat Cleanup / bulk delete (Edge/Chrome Extension)

How to install and use it: https://youtu.be/rALBULkVcn0

Not affiliated with or endorsed by OpenAI or ChatGPT.

Bulk-select and delete conversations from the ChatGPT sidebar. This extension injects a small “Chat Cleanup” panel into the chat history sidebar and adds checkboxes to conversations under **“Your chats”**, so you can remove many chats quickly with progress feedback.

> **Leave a star ⭐️ if you like it :)**

---

## Features

<img width="238" height="224" alt="Screenshot 2025-12-29 at 00 02 01" src="https://github.com/user-attachments/assets/584d7662-6877-4b08-b986-432e36662a64" />


- **Bulk selection**: Checkboxes next to chats under “Your chats”.
- **Select all / clear**: Quickly select or clear visible chats.
- **Bulk delete with progress**: Status and progress bar during deletion.
- **Fast but safe**: Uses moderate concurrency with retries and verification.
- **Fallback behavior**: If API deletion doesn’t reflect immediately, the extension can retry and may fall back to UI-based deletion.
- **Minimal permissions**: Uses `storage` only to remember whether the toggle is enabled.

---

## Supported Sites

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

---

## Install (From Source)

### Option A: Microsoft Edge 

1. Download or clone this repository:
   - Click **Code → Download ZIP**, then unzip it.
2. Open Edge and go to:
   - `edge://extensions`
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked**.
5. Select the folder that contains `manifest.json`.

### Option B: Google Chrome

1. Download or clone this repository (Code → Download ZIP).
2. Open Chrome and go to:
   - `chrome://extensions`
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the folder that contains `manifest.json`.

---

## Usage

1. Go to ChatGPT (`chatgpt.com` or `chat.openai.com`).
2. Open the chat history sidebar.
3. Scroll until you see the **“Your chats”** header.
4. In the sidebar, find the **Chat Cleanup** panel and toggle it **On**.
5. Select chats via checkboxes and click **Delete**.

**Important:** Deletion is permanent according to ChatGPT’s behavior. Review your selection before deleting.


