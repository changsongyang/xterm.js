/**
 * @license MIT
 */

import { ITerminal } from './Interfaces';
import { DomElementObjectPool } from './utils/DomElementObjectPool';

/**
 * The maximum number of refresh frames to skip when the write buffer is non-
 * empty. Note that these frames may be intermingled with frames that are
 * skipped via requestAnimationFrame's mechanism.
 */
const MAX_REFRESH_FRAME_SKIP = 5;

/**
 * Flags used to render terminal text properly.
 */
enum FLAGS {
  BOLD = 1,
  UNDERLINE = 2,
  BLINK = 4,
  INVERSE = 8,
  INVISIBLE = 16
};

let brokenBold: boolean = null;

export class Renderer {
  /** A queue of the rows to be refreshed */
  private _refreshRowsQueue: {start: number, end: number}[] = [];
  private _refreshFramesSkipped = 0;
  private _refreshAnimationFrame = null;

  private _spanElementObjectPool = new DomElementObjectPool('span');

  constructor(private _terminal: ITerminal) {
    // Figure out whether boldness affects
    // the character width of monospace fonts.
    if (brokenBold === null) {
      brokenBold = checkBoldBroken((<any>this._terminal).element);
    }
    this._spanElementObjectPool = new DomElementObjectPool('span');

    // TODO: Pull more DOM interactions into Renderer.constructor, element for
    // example should be owned by Renderer (and also exposed by Terminal due to
    // to established public API).
  }

  /**
   * Queues a refresh between two rows (inclusive), to be done on next animation
   * frame.
   * @param {number} start The start row.
   * @param {number} end The end row.
   */
  public queueRefresh(start: number, end: number): void {
    this._refreshRowsQueue.push({ start: start, end: end });
    if (!this._refreshAnimationFrame) {
      this._refreshAnimationFrame = window.requestAnimationFrame(this._refreshLoop.bind(this));
    }
  }

  /**
   * Performs the refresh loop callback, calling refresh only if a refresh is
   * necessary before queueing up the next one.
   */
  private _refreshLoop(): void {
    // Skip MAX_REFRESH_FRAME_SKIP frames if the writeBuffer is non-empty as it
    // will need to be immediately refreshed anyway. This saves a lot of
    // rendering time as the viewport DOM does not need to be refreshed, no
    // scroll events, no layouts, etc.
    const skipFrame = this._terminal.writeBuffer.length > 0 && this._refreshFramesSkipped++ <= MAX_REFRESH_FRAME_SKIP;
    if (skipFrame) {
      this._refreshAnimationFrame = window.requestAnimationFrame(this._refreshLoop.bind(this));
      return;
    }

    this._refreshFramesSkipped = 0;
    let start;
    let end;
    if (this._refreshRowsQueue.length > 4) {
      // Just do a full refresh when 5+ refreshes are queued
      start = 0;
      end = this._terminal.rows - 1;
    } else {
      // Get start and end rows that need refreshing
      start = this._refreshRowsQueue[0].start;
      end = this._refreshRowsQueue[0].end;
      for (let i = 1; i < this._refreshRowsQueue.length; i++) {
        if (this._refreshRowsQueue[i].start < start) {
          start = this._refreshRowsQueue[i].start;
        }
        if (this._refreshRowsQueue[i].end > end) {
          end = this._refreshRowsQueue[i].end;
        }
      }
    }
    this._refreshRowsQueue = [];
    this._refreshAnimationFrame = null;
    this._refresh(start, end);
  }

  /**
   * Refreshes (re-renders) terminal content within two rows (inclusive)
   *
   * Rendering Engine:
   *
   * In the screen buffer, each character is stored as a an array with a character
   * and a 32-bit integer:
   *   - First value: a utf-16 character.
   *   - Second value:
   *   - Next 9 bits: background color (0-511).
   *   - Next 9 bits: foreground color (0-511).
   *   - Next 14 bits: a mask for misc. flags:
   *     - 1=bold
   *     - 2=underline
   *     - 4=blink
   *     - 8=inverse
   *     - 16=invisible
   *
   * @param {number} start The row to start from (between 0 and terminal's height terminal - 1)
   * @param {number} end The row to end at (between fromRow and terminal's height terminal - 1)
   */
  private _refresh(start: number, end: number): void {
    let x, y, i, line, out, ch, ch_width, width, data, attr, bg, fg, flags, row, parent, focused = document.activeElement;

    // If this is a big refresh, remove the terminal rows from the DOM for faster calculations
    if (end - start >= this._terminal.rows / 2) {
      parent = this._terminal.element.parentNode;
      if (parent) {
        this._terminal.element.removeChild(this._terminal.rowContainer);
      }
    }

    width = this._terminal.cols;
    y = start;

    if (end >= this._terminal.rows) {
      this._terminal.log('`end` is too large. Most likely a bad CSR.');
      end = this._terminal.rows - 1;
    }

    for (; y <= end; y++) {
      row = y + this._terminal.ydisp;

      line = this._terminal.lines.get(row);
      out = '';

      if (this._terminal.y === y - (this._terminal.ybase - this._terminal.ydisp)
          && this._terminal.cursorState
          && !this._terminal.cursorHidden) {
        x = this._terminal.x;
      } else {
        x = -1;
      }

      attr = this._terminal.defAttr;
      i = 0;

      var documentFragment = document.createDocumentFragment();
      var innerHTML = '';
      var currentElement;

      // Return the row's spans to the pool
      while (this._terminal.children[y].children.length) {
        var child = this._terminal.children[y].children[0];
        this._terminal.children[y].removeChild(child);
        this._spanElementObjectPool.release(<HTMLElement>child);
      }

      for (; i < width; i++) {
        data = line[i][0];
        ch = line[i][1];
        ch_width = line[i][2];
        if (!ch_width)
          continue;

        if (i === x) data = -1;

        if (data !== attr) {
          if (attr !== this._terminal.defAttr) {
            if (innerHTML) {
              currentElement.innerHTML = innerHTML;
              innerHTML = '';
            }
            documentFragment.appendChild(currentElement);
            currentElement = null;
            //out += '</span>';
          }
          if (data !== this._terminal.defAttr) {
            if (innerHTML && !currentElement) {
              currentElement = this._spanElementObjectPool.acquire();
              // For some reason the text nodes only containing &nbsp; don't get added to the DOM
              //currentElement = document.createTextNode('');
            }
            if (currentElement) {
              if (innerHTML) {
                currentElement.innerHTML = innerHTML;
                innerHTML = '';
              }
              documentFragment.appendChild(currentElement);
            }
            currentElement = this._spanElementObjectPool.acquire();
            if (data === -1) {
              currentElement.classList.add('reverse-video', 'terminal-cursor');
              //out += '<span class="reverse-video terminal-cursor';
              // if (this._terminal.getOption('cursorBlink')) {
              //   currentElement.classList.add('blinking');
              //   //out += ' blinking';
              // }
              //out += '">';
            } else {
              //var classNames = [];

              bg = data & 0x1ff;
              fg = (data >> 9) & 0x1ff;
              flags = data >> 18;

              if (flags & FLAGS.BOLD) {
                if (!brokenBold) {
                  currentElement.classList.add('xterm-bold');
                  //classNames.push('xterm-bold');
                }
                // See: XTerm*boldColors
                if (fg < 8) fg += 8;
              }

              if (flags & FLAGS.UNDERLINE) {
                currentElement.classList.add('xterm-underline');
                //classNames.push('xterm-underline');
              }

              if (flags & FLAGS.BLINK) {
                currentElement.classList.add('xterm-blink');
                //classNames.push('xterm-blink');
              }

              // If inverse flag is on, then swap the foreground and background variables.
              if (flags & FLAGS.INVERSE) {
                /* One-line variable swap in JavaScript: http://stackoverflow.com/a/16201730 */
                bg = [fg, fg = bg][0];
                // Should inverse just be before the
                // above boldColors effect instead?
                if ((flags & 1) && fg < 8) fg += 8;
              }

              if (flags & FLAGS.INVISIBLE) {
                currentElement.classList.add('xterm-hidden');
                //classNames.push('xterm-hidden');
              }

              /**
               * Weird situation: Invert flag used black foreground and white background results
               * in invalid background color, positioned at the 256 index of the 256 terminal
               * color map. Pin the colors manually in such a case.
               *
               * Source: https://github.com/sourcelair/xterm.js/issues/57
               */
              if (flags & FLAGS.INVERSE) {
                if (bg == 257) {
                  bg = 15;
                }
                if (fg == 256) {
                  fg = 0;
                }
              }

              if (bg < 256) {
                currentElement.classList.add('xterm-bg-color-' + bg);
                //classNames.push('xterm-bg-color-' + bg);
              }

              if (fg < 256) {
                currentElement.classList.add('xterm-color-' + fg);
                //classNames.push('xterm-color-' + fg);
              }

              // out += '<span';
              // if (classNames.length) {
              //   out += ' class="' + classNames.join(' ') + '"';
              // }
              // out += '>';
            }
          }
        }

        if (ch_width === 2) {
          out += '<span class="xterm-wide-char">';
        }
        switch (ch) {
          case '&':
            innerHTML += '&amp;';
            //out += '&amp;';
            break;
          case '<':
            innerHTML += '&lt;';
            //out += '&lt;';
            break;
          case '>':
            innerHTML += '&gt;';
            //out += '&gt;';
            break;
          default:
            if (ch <= ' ') {
              innerHTML += '&nbsp;';
              //out += '&nbsp;';
            } else {
              innerHTML += ch;
              // out += ch;
            }
            break;
        }
        if (ch_width === 2) {
          out += '</span>';
        }

        attr = data;
      }

      if (innerHTML && !currentElement) {
        currentElement = this._spanElementObjectPool.acquire();
        // For some reason the text nodes only containing &nbsp; don't get added to the DOM
        //currentElement = document.createTextNode('');
      }
      if (currentElement) {
        if (innerHTML) {
          currentElement.innerHTML = innerHTML;
          innerHTML = '';
        }
        documentFragment.appendChild(currentElement);
        currentElement = null;
      }
      // if (attr !== this.defAttr) {
      //   out += '</span>';
      // }

      //this.children[y].innerHTML = out;
      //this.children[y].innerHTML = '';

      this._terminal.children[y].appendChild(documentFragment)
    }

    if (parent) {
      this._terminal.element.appendChild(this._terminal.rowContainer);
    }

    this._terminal.emit('refresh', {element: this._terminal.element, start: start, end: end});
  };
}


// if bold is broken, we can't
// use it in the terminal.
function checkBoldBroken(terminal) {
  const document = terminal.ownerDocument;
  const el = document.createElement('span');
  el.innerHTML = 'hello world';
  terminal.appendChild(el);
  const w1 = el.offsetWidth;
  const h1 = el.offsetHeight;
  el.style.fontWeight = 'bold';
  const w2 = el.offsetWidth;
  const h2 = el.offsetHeight;
  terminal.removeChild(el);
  return w1 !== w2 || h1 !== h2;
}
