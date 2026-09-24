import { Lexer } from "marked";
import type { Token, Tokens } from "marked";

// Replies come from the model, so they are rendered from tokens into DOM nodes and never
// through innerHTML. Raw HTML in a reply shows up as literal text.

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  appendBlocks(fragment, Lexer.lex(source, { gfm: true }));
  return fragment;
}

function appendBlocks(parent: Node, tokens: readonly Token[]) {
  for (const token of tokens) {
    const node = blockNode(token);
    if (node) parent.appendChild(node);
  }
}

function blockNode(token: Token): Node | undefined {
  switch (token.type) {
    case "space":
    case "def":
      return undefined;
    case "paragraph":
      return withInline(document.createElement("p"), (token as Tokens.Paragraph).tokens);
    case "text": {
      const text = token as Tokens.Text;
      return text.tokens ? withInline(document.createElement("p"), text.tokens) : element("p", decodeEntities(text.text));
    }
    case "heading": {
      const heading = token as Tokens.Heading;
      return withInline(document.createElement(`h${Math.min(Math.max(heading.depth, 1), 6)}`), heading.tokens);
    }
    case "code": {
      const code = element("code", (token as Tokens.Code).text);
      const pre = document.createElement("pre");
      pre.appendChild(code);
      return pre;
    }
    case "blockquote": {
      const quote = document.createElement("blockquote");
      appendBlocks(quote, (token as Tokens.Blockquote).tokens);
      return quote;
    }
    case "list":
      return listNode(token as Tokens.List);
    case "table":
      return tableNode(token as Tokens.Table);
    case "hr":
      return document.createElement("hr");
    case "html":
      return element("pre", token.raw.replace(/\n+$/, ""));
    default:
      return token.raw ? element("p", token.raw) : undefined;
  }
}

function listNode(list: Tokens.List) {
  const container = document.createElement(list.ordered ? "ol" : "ul");
  if (list.ordered && typeof list.start === "number" && list.start !== 1) container.setAttribute("start", String(list.start));
  for (const item of list.items) {
    const listItem = document.createElement("li");
    if (item.task) listItem.className = "task";
    for (const child of item.tokens) {
      if (child.type === "checkbox") {
        listItem.appendChild(checkbox((child as Tokens.Checkbox).checked));
      } else if (child.type === "text" && !list.loose) {
        const text = child as Tokens.Text;
        if (text.tokens) appendInline(listItem, text.tokens);
        else listItem.append(decodeEntities(text.text));
      } else {
        const node = blockNode(child);
        if (node) listItem.appendChild(node);
      }
    }
    container.appendChild(listItem);
  }
  return container;
}

function checkbox(checked: boolean) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.disabled = true;
  input.setAttribute("aria-label", checked ? "Done" : "Not done");
  return input;
}

function tableNode(table: Tokens.Table) {
  const wrapper = document.createElement("div");
  wrapper.className = "table-scroll";
  const tableElement = document.createElement("table");
  const head = document.createElement("thead");
  head.appendChild(tableRow(table.header, "th"));
  const body = document.createElement("tbody");
  for (const row of table.rows) body.appendChild(tableRow(row, "td"));
  tableElement.append(head, body);
  wrapper.appendChild(tableElement);
  return wrapper;
}

function tableRow(cells: readonly Tokens.TableCell[], tag: "th" | "td") {
  const row = document.createElement("tr");
  for (const cell of cells) {
    const cellElement = withInline(document.createElement(tag), cell.tokens);
    if (cell.align) cellElement.style.textAlign = cell.align;
    row.appendChild(cellElement);
  }
  return row;
}

function withInline<T extends HTMLElement>(parent: T, tokens: readonly Token[]): T {
  appendInline(parent, tokens);
  return parent;
}

function appendInline(parent: Node, tokens: readonly Token[]) {
  for (const token of tokens) parent.appendChild(inlineNode(token));
}

function inlineNode(token: Token): Node {
  switch (token.type) {
    case "text": {
      const text = token as Tokens.Text;
      if (text.tokens) {
        const fragment = document.createDocumentFragment();
        appendInline(fragment, text.tokens);
        return fragment;
      }
      return document.createTextNode(decodeEntities(text.text));
    }
    case "escape":
      return document.createTextNode((token as Tokens.Escape).text);
    case "strong":
      return withInline(document.createElement("strong"), (token as Tokens.Strong).tokens);
    case "em":
      return withInline(document.createElement("em"), (token as Tokens.Em).tokens);
    case "del":
      return withInline(document.createElement("del"), (token as Tokens.Del).tokens);
    case "codespan":
      return element("code", (token as Tokens.Codespan).text);
    case "br":
      return document.createElement("br");
    case "checkbox":
      return checkbox((token as Tokens.Checkbox).checked);
    case "link": {
      const link = token as Tokens.Link;
      const href = safeHref(link.autolink ? link.href : decodeEntities(link.href));
      const content = document.createDocumentFragment();
      appendInline(content, link.tokens);
      return href ? anchor(href, content, link.title) : content;
    }
    case "image": {
      const image = token as Tokens.Image;
      // The CSP blocks remote images, so an image becomes a link to it.
      const label = decodeEntities(image.text) || image.href;
      const href = safeHref(decodeEntities(image.href));
      return href ? anchor(href, document.createTextNode(label), image.title) : document.createTextNode(label);
    }
    default:
      return document.createTextNode(token.raw);
  }
}

function anchor(href: string, content: Node, title: string | null | undefined) {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  if (title) link.title = decodeEntities(title);
  link.appendChild(content);
  return link;
}

export function safeHref(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return undefined;
  }
  return SAFE_LINK_PROTOCOLS.has(url.protocol) ? url.href : undefined;
}

export function decodeEntities(text: string) {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g, (match, decimal, hex, name) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? match;
    const codePoint = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex, 16);
    const valid = codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
    return valid ? String.fromCodePoint(codePoint) : "\ufffd";
  });
}

function element(tag: string, text: string) {
  const created = document.createElement(tag);
  created.textContent = text;
  return created;
}
