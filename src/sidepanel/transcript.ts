import { PROMPT_AUTHOR_LABEL } from "./copy.ts";

export type TranscriptTurn = {
  appendReply: (text: string) => void;
  showUsage: (text: string) => void;
  finish: (note?: string) => void;
};

const END_OF_LOG_TOLERANCE_PX = 24;

export function createTranscript(log: HTMLElement, emptyText: string) {
  const emptyNotice = textElement("p", "transcript-empty", emptyText);
  let turnCount = 0;

  function clear() {
    turnCount = 0;
    log.setAttribute("aria-busy", "false");
    log.replaceChildren(emptyNotice);
  }

  function startTurn(prompt: string, replyAuthor: string): TranscriptTurn {
    const reply = textElement("pre", "reply", "");
    const note = textElement("p", "turn-note", "");
    const usage = textElement("p", "usage", "");
    note.hidden = true;
    usage.hidden = true;
    const turn = document.createElement("article");
    turn.className = "turn";
    turn.append(
      textElement("p", "speaker", PROMPT_AUTHOR_LABEL),
      textElement("pre", "prompt-text", prompt),
      textElement("p", "speaker", replyAuthor),
      reply,
      note,
      usage,
    );
    if (turnCount === 0) log.replaceChildren();
    turnCount += 1;
    log.append(turn);
    log.setAttribute("aria-busy", "true");
    scrollToEnd();

    return {
      appendReply(text) {
        keepingEndInView(() => reply.append(text));
      },
      showUsage(text) {
        keepingEndInView(() => {
          usage.textContent = text;
          usage.hidden = false;
        });
      },
      finish(noteText) {
        if (noteText !== undefined) {
          keepingEndInView(() => {
            note.textContent = noteText;
            note.hidden = false;
          });
        }
        log.setAttribute("aria-busy", "false");
      },
    };
  }

  function keepingEndInView(change: () => void) {
    const wasAtEnd = log.scrollHeight - log.scrollTop - log.clientHeight <= END_OF_LOG_TOLERANCE_PX;
    change();
    if (wasAtEnd) scrollToEnd();
  }

  function scrollToEnd() {
    log.scrollTop = log.scrollHeight;
  }

  clear();
  return { clear, startTurn, hasTurns: () => turnCount > 0 };
}

function textElement(tag: "p" | "pre", className: string, text: string) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}
