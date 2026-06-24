/**
 * PI Text Input
 *
 * Standalone multiline text input dialog using the same Editor, TUI, and
 * CombinedAutocompleteProvider that PI's interactive mode uses.
 *
 * Pattern adapted from the project-builder pi extension's FeatureContextDialog:
 *   /Users/gabrielxavier/.pi/agent/extensions/project-builder/src/ui/commands.ts
 *
 * Gives you:
 *   - @ file references (fuzzy search project files)
 *   - Tab path completion
 *   - Shift+Enter for newlines
 *   - Full readline-style keybindings (Ctrl+W, Alt+Backspace, etc.)
 *   - Undo (Ctrl+Z / Ctrl+Shift+Z)
 *   - Kill ring (Ctrl+K, Ctrl+Y, Alt+Y)
 *
 * Usage:
 *   const text = await piTextInput({
 *     prompt: "What do you want to build?",
 *     cwd: process.cwd(),
 *   });
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  type EditorTheme,
  type Focusable,
  matchesKey,
  ProcessTerminal,
  Text,
  TUI,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Minimal theme (match pi's dark theme)
// ============================================================================

const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const accent = (text: string) => `\x1b[36m${text}\x1b[39m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;

const editorTheme: EditorTheme = {
  borderColor: (text: string) => dim(text),
  selectList: {
    selectedPrefix: (text: string) => accent(text),
    selectedText: (text: string) => bold(text),
    description: (text: string) => dim(text),
    scrollInfo: (text: string) => dim(text),
    noMatch: (text: string) => dim(text),
  },
};

// ============================================================================
// Options
// ============================================================================

export interface PiTextInputOptions {
  /** Prompt shown as the dialog title. */
  prompt: string;
  /** Working directory for @ file reference autocomplete. */
  cwd: string;
  /** Placeholder text (pre-filled editor content). */
  placeholder?: string;
  /** Optional path to `fd` for faster file discovery. */
  fdPath?: string;
  /** Max visible autocomplete items (default: 10). */
  autocompleteMaxVisible?: number;
}

// ============================================================================
// Multiline Dialog (Container + Editor — same pattern as pi extension)
// ============================================================================

/**
 * A multiline text input dialog using the Editor component.
 *
 * Layout:
 *   ═══════════════════  (DynamicBorder top)
 *   Prompt title         (Text, accent + bold)
 *   │ ...editor...       (Editor with paddingX: 1)
 *   Help text            (Text, dim)
 *   ═══════════════════  (DynamicBorder bottom)
 *
 * Submit with Enter, cancel with Escape, new line with Shift+Enter.
 */
class MultilineInputDialog extends Container implements Focusable {
  private editor: Editor;
  private tui: TUI;
  private onDone: (value: string | undefined) => void;

  /** Focusable — propagate to child Editor for IME cursor positioning */
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  constructor(
    tui: TUI,
    title: string,
    onDone: (value: string | undefined) => void,
    projectRoot: string,
    fdPath: string | null,
    placeholder?: string,
  ) {
    super();
    this.tui = tui;
    this.onDone = onDone;

    // Top border
    this.addChild(new DynamicBorder((s: string) => accent(s)));

    // Title
    this.addChild(new Text(accent(bold(title)), 1, 0));

    // Editor with padding (matches pi extension's editorTheme)
    this.editor = new Editor(tui, editorTheme, { paddingX: 1 });
    this.editor.onSubmit = (value: string) => {
      // Submit on Enter — pass text even if empty (caller decides)
      const trimmed = value.trim();
      onDone(trimmed || undefined);
    };

    // Enable @ file-reference autocomplete (fuzzy file search scoped to project root).
    // fdPath enables fd-based fuzzy search; null falls back to prefix-based completion.
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider([], projectRoot, fdPath),
    );

    if (placeholder) {
      this.editor.setText(placeholder);
    }

    this.addChild(this.editor);

    // Help text
    this.addChild(
      new Text(
        dim("Shift+Enter for new line • Enter to submit • Esc to skip"),
        1,
        0,
      ),
    );

    // Bottom border
    this.addChild(new DynamicBorder((s: string) => accent(s)));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      // Escape cancels — only if editor is empty (matches pi extension behavior)
      if (this.editor.getText().trim().length === 0) {
        this.onDone(undefined);
        return;
      }
      // If editor has content, let the editor handle escape (clears text)
      this.editor.handleInput(data);
      this.tui.requestRender();
      return;
    }
    this.editor.handleInput(data);
    this.tui.requestRender();
  }

  override invalidate(): void {
    super.invalidate();
  }
}

// ============================================================================
// piTextInput — public API
// ============================================================================

/**
 * Open a PI-style multiline text editor dialog and return the user's text.
 *
 * Takes over the terminal with a full TUI instance. Blocks until the user
 * submits (Enter) or cancels (Escape on empty editor).
 *
 * @returns The submitted text, or `null` if cancelled.
 */
export function piTextInput(options: PiTextInputOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const {
      prompt,
      cwd,
      placeholder,
      fdPath: explicitFdPath,
      autocompleteMaxVisible = 10,
    } = options;

    const fdPath = explicitFdPath ?? resolveFdPath();

    // ── Set up terminal + TUI ────────────────────────────────
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal, true);

    // ── Create dialog ────────────────────────────────────────
    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      tui.stop();
      terminal.stop();
      // Restore cursor + newline for the next prompt
      process.stdout.write("\x1b[?25h\n");
    };

    const dialog = new MultilineInputDialog(
      tui,
      prompt,
      (value: string | undefined) => {
        cleanup();
        resolve(value ?? null);
      },
      cwd,
      fdPath,
      placeholder,
    );

    // ── Mount and start ──────────────────────────────────────
    tui.addChild(dialog);
    tui.setFocus(dialog);
    tui.start();
  });
}

// ============================================================================
// Internal
// ============================================================================

/**
 * Resolve the path to the `fd` binary, which is required by
 * CombinedAutocompleteProvider for @ fuzzy file autocomplete.
 *
 * Checks pi's standard bin directory first (where pi automatically
 * downloads fd on first run), then falls back to the system PATH.
 * Returns null if fd is not found — autocomplete falls back to
 * prefix-based file completion.
 */
function resolveFdPath(): string | null {
  // 1. Check pi's standard bin dir (~/.pi/agent/bin/fd)
  const piBinFd = join(homedir(), ".pi", "agent", "bin", "fd");
  if (existsSync(piBinFd)) return piBinFd;

  // 2. Check PATH for fd or fdfind (Debian/Ubuntu rename)
  const whichNames = process.platform === "win32"
    ? ["fd.exe", "fdfind.exe"]
    : ["fd", "fdfind"];
  const whichCmd = process.platform === "win32" ? "where" : "which";
  for (const name of whichNames) {
    const result = spawnSync(whichCmd, [name], {
      encoding: "utf-8",
      timeout: 2000,
    });
    if (result.status === 0 && result.stdout) {
      const path = result.stdout.trim().split("\n")[0].trim();
      if (path) return path;
    }
  }

  return null;
}
