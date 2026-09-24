import { PROMPT_AUTHOR_LABEL } from "./copy.ts";

export type TranscriptTurn = {
  appendReply: (text: string) => void;
  finish: (note?: string) => void;
};

const END_OF_LOG_TOLERANCE_PX = 24;

export function createTranscript(log: HTMLElement) {
  let turnCount = 0;

  function clear() {
    turnCount = 0;
    log.setAttribute("aria-busy", "false");
    log.replaceChildren();
    log.hidden = true;
  }

  function startTurn(prompt: string, replyAuthor: string): TranscriptTurn {
    const reply = textElement("pre", "reply", "");
    const note = textElement("p", "turn-note", "");
    note.hidden = true;
    const turn = document.createElement("article");
    turn.className = "turn";
    turn.append(
      textElement("p", "speaker visually-hidden", PROMPT_AUTHOR_LABEL),
      textElement("pre", "prompt-text", prompt),
      textElement("p", "speaker visually-hidden", replyAuthor),
      reply,
      note,
    );
    turnCount += 1;
    // Attach the live region before the first turn lands so streamed replies are announced.
    log.hidden = false;
    log.append(turn);
    log.setAttribute("aria-busy", "true");
    scrollToEnd();

    return {
      appendReply(text) {
        keepingEndInView(() => reply.append(text));
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
