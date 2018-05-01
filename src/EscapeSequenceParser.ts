/**
 * TODO:
 * - docs
 * - extend test cases
 */
import { ParserState, ParserAction, IParsingState, IDcsHandler, IEscapeSequenceParser } from './Types';

// number range macro
function r(a: number, b: number): number[] {
  let c = b - a;
  let arr = new Array(c);
  while (c--) {
    arr[c] = --b;
  }
  return arr;
}

/**
 * Transition table for EscapeSequenceParser.
 * NOTE: data in the underlying table is packed like this:
 *   currentState << 8 | characterCode  -->  action << 4 | nextState
 */
export class TransitionTable {
  public table: Uint8Array | number[];

  constructor(length: number) {
    this.table = (typeof Uint32Array === 'undefined')
      ? new Array(length)
      : new Uint32Array(length);
  }

  /**
   * Add a new transition to the transition table.
   * @param code input character code
   * @param state current parser state
   * @param action parser action to be done
   * @param next next parser state
   */
  add(code: number, state: number, action: number | null, next: number | null): void {
    this.table[state << 8 | code] = ((action | 0) << 4) | ((next === undefined) ? state : next);
  }

  /**
   * Add transitions for multiple input characters codes.
   * @param codes input character code array
   * @param state current parser state
   * @param action parser action to be done
   * @param next next parser state
   */
  addMany(codes: number[], state: number, action: number | null, next: number | null): void {
    for (let i = 0; i < codes.length; i++) {
      this.add(codes[i], state, action, next);
    }
  }
}


/**
 * Default definitions for the VT500_TRANSITION_TABLE.
 */
let PRINTABLES = r(0x20, 0x7f);
let EXECUTABLES = r(0x00, 0x18);
EXECUTABLES.push(0x19);
EXECUTABLES.concat(r(0x1c, 0x20));
const DEFAULT_TRANSITION = ParserAction.ERROR << 4 | ParserState.GROUND;

/**
 * VT500 compatible transition table.
 * Taken from https://vt100.net/emu/dec_ansi_parser.
 */
export const VT500_TRANSITION_TABLE = (function (): TransitionTable {
  let table: TransitionTable = new TransitionTable(4095);

  let states: number[] = r(ParserState.GROUND, ParserState.DCS_PASSTHROUGH + 1);
  let state: any;

  // table with default transition [any] --> DEFAULT_TRANSITION
  for (state in states) {
    // NOTE: table lookup is capped at 0xa0 in parse to keep the table small
    for (let code = 0; code < 160; ++code) {
      table.add(code, state, ParserAction.ERROR, ParserState.GROUND);
    }
  }
  // printables
  table.addMany(PRINTABLES, ParserState.GROUND, ParserAction.PRINT, ParserState.GROUND);
  // global anywhere rules
  for (state in states) {
    table.addMany([0x18, 0x1a, 0x99, 0x9a], state, ParserAction.EXECUTE, ParserState.GROUND);
    table.addMany(r(0x80, 0x90), state, ParserAction.EXECUTE, ParserState.GROUND);
    table.addMany(r(0x90, 0x98), state, ParserAction.EXECUTE, ParserState.GROUND);
    table.add(0x9c, state, ParserAction.IGNORE, ParserState.GROUND); // ST as terminator
    table.add(0x1b, state, ParserAction.CLEAR, ParserState.ESCAPE);  // ESC
    table.add(0x9d, state, ParserAction.OSC_START, ParserState.OSC_STRING);  // OSC
    table.addMany([0x98, 0x9e, 0x9f], state, ParserAction.IGNORE, ParserState.SOS_PM_APC_STRING);
    table.add(0x9b, state, ParserAction.CLEAR, ParserState.CSI_ENTRY);  // CSI
    table.add(0x90, state, ParserAction.CLEAR, ParserState.DCS_ENTRY);  // DCS
  }
  // rules for executables and 7f
  table.addMany(EXECUTABLES, ParserState.GROUND, ParserAction.EXECUTE, ParserState.GROUND);
  table.addMany(EXECUTABLES, ParserState.ESCAPE, ParserAction.EXECUTE, ParserState.ESCAPE);
  table.add(0x7f, ParserState.ESCAPE, ParserAction.IGNORE, ParserState.ESCAPE);
  table.addMany(EXECUTABLES, ParserState.OSC_STRING, ParserAction.IGNORE, ParserState.OSC_STRING);
  table.addMany(EXECUTABLES, ParserState.CSI_ENTRY, ParserAction.EXECUTE, ParserState.CSI_ENTRY);
  table.add(0x7f, ParserState.CSI_ENTRY, ParserAction.IGNORE, ParserState.CSI_ENTRY);
  table.addMany(EXECUTABLES, ParserState.CSI_PARAM, ParserAction.EXECUTE, ParserState.CSI_PARAM);
  table.add(0x7f, ParserState.CSI_PARAM, ParserAction.IGNORE, ParserState.CSI_PARAM);
  table.addMany(EXECUTABLES, ParserState.CSI_IGNORE, ParserAction.EXECUTE, ParserState.CSI_IGNORE);
  table.addMany(EXECUTABLES, ParserState.CSI_INTERMEDIATE, ParserAction.EXECUTE, ParserState.CSI_INTERMEDIATE);
  table.add(0x7f, ParserState.CSI_INTERMEDIATE, ParserAction.IGNORE, ParserState.CSI_INTERMEDIATE);
  table.addMany(EXECUTABLES, ParserState.ESCAPE_INTERMEDIATE, ParserAction.EXECUTE, ParserState.ESCAPE_INTERMEDIATE);
  table.add(0x7f, ParserState.ESCAPE_INTERMEDIATE, ParserAction.IGNORE, ParserState.ESCAPE_INTERMEDIATE);
  // osc
  table.add(0x5d, ParserState.ESCAPE, ParserAction.OSC_START, ParserState.OSC_STRING);
  table.addMany(PRINTABLES, ParserState.OSC_STRING, ParserAction.OSC_PUT, ParserState.OSC_STRING);
  table.add(0x7f, ParserState.OSC_STRING, ParserAction.OSC_PUT, ParserState.OSC_STRING);
  table.addMany([0x9c, 0x1b, 0x18, 0x1a, 0x07], ParserState.OSC_STRING, ParserAction.OSC_END, ParserState.GROUND);
  table.addMany(r(0x1c, 0x20), ParserState.OSC_STRING, ParserAction.IGNORE, ParserState.OSC_STRING);
  // sos/pm/apc does nothing
  table.addMany([0x58, 0x5e, 0x5f], ParserState.ESCAPE, ParserAction.IGNORE, ParserState.SOS_PM_APC_STRING);
  table.addMany(PRINTABLES, ParserState.SOS_PM_APC_STRING, ParserAction.IGNORE, ParserState.SOS_PM_APC_STRING);
  table.addMany(EXECUTABLES, ParserState.SOS_PM_APC_STRING, ParserAction.IGNORE, ParserState.SOS_PM_APC_STRING);
  table.add(0x9c, ParserState.SOS_PM_APC_STRING, ParserAction.IGNORE, ParserState.GROUND);
  // csi entries
  table.add(0x5b, ParserState.ESCAPE, ParserAction.CLEAR, ParserState.CSI_ENTRY);
  table.addMany(r(0x40, 0x7f), ParserState.CSI_ENTRY, ParserAction.CSI_DISPATCH, ParserState.GROUND);
  table.addMany(r(0x30, 0x3a), ParserState.CSI_ENTRY, ParserAction.PARAM, ParserState.CSI_PARAM);
  table.add(0x3b, ParserState.CSI_ENTRY, ParserAction.PARAM, ParserState.CSI_PARAM);
  table.addMany([0x3c, 0x3d, 0x3e, 0x3f], ParserState.CSI_ENTRY, ParserAction.COLLECT, ParserState.CSI_PARAM);
  table.addMany(r(0x30, 0x3a), ParserState.CSI_PARAM, ParserAction.PARAM, ParserState.CSI_PARAM);
  table.add(0x3b, ParserState.CSI_PARAM, ParserAction.PARAM, ParserState.CSI_PARAM);
  table.addMany(r(0x40, 0x7f), ParserState.CSI_PARAM, ParserAction.CSI_DISPATCH, ParserState.GROUND);
  table.addMany([0x3a, 0x3c, 0x3d, 0x3e, 0x3f], ParserState.CSI_PARAM, ParserAction.IGNORE, ParserState.CSI_IGNORE);
  table.addMany(r(0x20, 0x40), ParserState.CSI_IGNORE, null, ParserState.CSI_IGNORE);
  table.add(0x7f, ParserState.CSI_IGNORE, null, ParserState.CSI_IGNORE);
  table.addMany(r(0x40, 0x7f), ParserState.CSI_IGNORE, ParserAction.IGNORE, ParserState.GROUND);
  table.add(0x3a, ParserState.CSI_ENTRY, ParserAction.IGNORE, ParserState.CSI_IGNORE);
  table.addMany(r(0x20, 0x30), ParserState.CSI_ENTRY, ParserAction.COLLECT, ParserState.CSI_INTERMEDIATE);
  table.addMany(r(0x20, 0x30), ParserState.CSI_INTERMEDIATE, ParserAction.COLLECT, ParserState.CSI_INTERMEDIATE);
  table.addMany(r(0x30, 0x40), ParserState.CSI_INTERMEDIATE, ParserAction.IGNORE, ParserState.CSI_IGNORE);
  table.addMany(r(0x40, 0x7f), ParserState.CSI_INTERMEDIATE, ParserAction.CSI_DISPATCH, ParserState.GROUND);
  table.addMany(r(0x20, 0x30), ParserState.CSI_PARAM, ParserAction.COLLECT, ParserState.CSI_INTERMEDIATE);
  // esc_intermediate
  table.addMany(r(0x20, 0x30), ParserState.ESCAPE, ParserAction.COLLECT, ParserState.ESCAPE_INTERMEDIATE);
  table.addMany(r(0x20, 0x30), ParserState.ESCAPE_INTERMEDIATE, ParserAction.COLLECT, ParserState.ESCAPE_INTERMEDIATE);
  table.addMany(r(0x30, 0x7f), ParserState.ESCAPE_INTERMEDIATE, ParserAction.ESC_DISPATCH, ParserState.GROUND);
  table.addMany(r(0x30, 0x50), ParserState.ESCAPE, ParserAction.ESC_DISPATCH, ParserState.GROUND);
  table.addMany(r(0x51, 0x58), ParserState.ESCAPE, ParserAction.ESC_DISPATCH, ParserState.GROUND);
  table.addMany([0x59, 0x5a, 0x5c], ParserState.ESCAPE, ParserAction.ESC_DISPATCH, ParserState.GROUND);
  table.addMany(r(0x60, 0x7f), ParserState.ESCAPE, ParserAction.ESC_DISPATCH, ParserState.GROUND);
  // dcs entry
  table.add(0x50, ParserState.ESCAPE, ParserAction.CLEAR, ParserState.DCS_ENTRY);
  table.addMany(EXECUTABLES, ParserState.DCS_ENTRY, ParserAction.IGNORE, ParserState.DCS_ENTRY);
  table.add(0x7f, ParserState.DCS_ENTRY, ParserAction.IGNORE, ParserState.DCS_ENTRY);
  table.addMany(r(0x1c, 0x20), ParserState.DCS_ENTRY, ParserAction.IGNORE, ParserState.DCS_ENTRY);
  table.addMany(r(0x20, 0x30), ParserState.DCS_ENTRY, ParserAction.COLLECT, ParserState.DCS_INTERMEDIATE);
  table.add(0x3a, ParserState.DCS_ENTRY, ParserAction.IGNORE, ParserState.DCS_IGNORE);
  table.addMany(r(0x30, 0x3a), ParserState.DCS_ENTRY, ParserAction.PARAM, ParserState.DCS_PARAM);
  table.add(0x3b, ParserState.DCS_ENTRY, ParserAction.PARAM, ParserState.DCS_PARAM);
  table.addMany([0x3c, 0x3d, 0x3e, 0x3f], ParserState.DCS_ENTRY, ParserAction.COLLECT, ParserState.DCS_PARAM);
  table.addMany(EXECUTABLES, ParserState.DCS_IGNORE, ParserAction.IGNORE, ParserState.DCS_IGNORE);
  table.addMany(r(0x20, 0x80), ParserState.DCS_IGNORE, ParserAction.IGNORE, ParserState.DCS_IGNORE);
  table.addMany(r(0x1c, 0x20), ParserState.DCS_IGNORE, ParserAction.IGNORE, ParserState.DCS_IGNORE);
  table.addMany(EXECUTABLES, ParserState.DCS_PARAM, ParserAction.IGNORE, ParserState.DCS_PARAM);
  table.add(0x7f, ParserState.DCS_PARAM, ParserAction.IGNORE, ParserState.DCS_PARAM);
  table.addMany(r(0x1c, 0x20), ParserState.DCS_PARAM, ParserAction.IGNORE, ParserState.DCS_PARAM);
  table.addMany(r(0x30, 0x3a), ParserState.DCS_PARAM, ParserAction.PARAM, ParserState.DCS_PARAM);
  table.add(0x3b, ParserState.DCS_PARAM, ParserAction.PARAM, ParserState.DCS_PARAM);
  table.addMany([0x3a, 0x3c, 0x3d, 0x3e, 0x3f], ParserState.DCS_PARAM, ParserAction.IGNORE, ParserState.DCS_IGNORE);
  table.addMany(r(0x20, 0x30), ParserState.DCS_PARAM, ParserAction.COLLECT, ParserState.DCS_INTERMEDIATE);
  table.addMany(EXECUTABLES, ParserState.DCS_INTERMEDIATE, ParserAction.IGNORE, ParserState.DCS_INTERMEDIATE);
  table.add(0x7f, ParserState.DCS_INTERMEDIATE, ParserAction.IGNORE, ParserState.DCS_INTERMEDIATE);
  table.addMany(r(0x1c, 0x20), ParserState.DCS_INTERMEDIATE, ParserAction.IGNORE, ParserState.DCS_INTERMEDIATE);
  table.addMany(r(0x20, 0x30), ParserState.DCS_INTERMEDIATE, ParserAction.COLLECT, ParserState.DCS_INTERMEDIATE);
  table.addMany(r(0x30, 0x40), ParserState.DCS_INTERMEDIATE, ParserAction.IGNORE, ParserState.DCS_IGNORE);
  table.addMany(r(0x40, 0x7f), ParserState.DCS_INTERMEDIATE, ParserAction.DCS_HOOK, ParserState.DCS_PASSTHROUGH);
  table.addMany(r(0x40, 0x7f), ParserState.DCS_PARAM, ParserAction.DCS_HOOK, ParserState.DCS_PASSTHROUGH);
  table.addMany(r(0x40, 0x7f), ParserState.DCS_ENTRY, ParserAction.DCS_HOOK, ParserState.DCS_PASSTHROUGH);
  table.addMany(EXECUTABLES, ParserState.DCS_PASSTHROUGH, ParserAction.DCS_PUT, ParserState.DCS_PASSTHROUGH);
  table.addMany(PRINTABLES, ParserState.DCS_PASSTHROUGH, ParserAction.DCS_PUT, ParserState.DCS_PASSTHROUGH);
  table.add(0x7f, ParserState.DCS_PASSTHROUGH, ParserAction.IGNORE, ParserState.DCS_PASSTHROUGH);
  table.addMany([0x1b, 0x9c], ParserState.DCS_PASSTHROUGH, ParserAction.DCS_UNHOOK, ParserState.GROUND);
  return table;
})();

/**
 * Dummy DCS handler as default fallback.
 */
class DcsDummy implements IDcsHandler {
  hook(collect: string, params: number[], flag: number): void { }
  put(data: string, start: number, end: number): void { }
  unhook(): void { }
}

/**
 * EscapeSequenceParser.
 * This class implements the ANSI/DEC compatible parser described by
 * Paul Williams (https://vt100.net/emu/dec_ansi_parser).
 * NOTE: The parameter element notation is currently not supported.
 */
export class EscapeSequenceParser implements IEscapeSequenceParser {
  public initialState: number;
  public currentState: number;
  readonly transitions: TransitionTable;

  // buffers over several parse calls
  // FIXME: make those protected (needs workaround in tests)
  public osc: string;
  public params: number[];
  public collect: string;

  // callback slots
  protected _printHandler: (data: string, start: number, end: number) => void;
  protected _executeHandlers: any;
  protected _csiHandlers: any;
  protected _escHandlers: any;
  protected _oscHandlers: any;
  protected _dcsHandlers: any;
  protected _activeDcsHandler: IDcsHandler | null;
  protected _errorHandler: (state: IParsingState) => IParsingState;

  // fallback handlers
  protected _printHandlerFb: (data: string, start: number, end: number) => void;
  protected _executeHandlerFb: (...params: any[]) => void;
  protected _csiHandlerFb: (...params: any[]) => void;
  protected _escHandlerFb: (...params: any[]) => void;
  protected _oscHandlerFb: (...params: any[]) => void;
  protected _dcsHandlerFb: IDcsHandler;
  protected _errorHandlerFb: (state: IParsingState) => IParsingState;

  constructor(transitions: TransitionTable = VT500_TRANSITION_TABLE) {
    this.initialState = ParserState.GROUND;
    this.currentState = this.initialState;
    this.transitions = transitions;
    this.osc = '';
    this.params = [0];
    this.collect = '';

    // set default fallback handlers
    this._printHandlerFb = (data, start, end): void => { };
    this._executeHandlerFb = (...params: any[]): void => { };
    this._csiHandlerFb = (...params: any[]): void => { };
    this._escHandlerFb = (...params: any[]): void => { };
    this._oscHandlerFb = (...params: any[]): void => { };
    this._dcsHandlerFb = new DcsDummy;
    this._errorHandlerFb = (state: IParsingState): IParsingState => state;
    this._printHandler = this._printHandlerFb;
    this._executeHandlers = Object.create(null);
    this._csiHandlers = Object.create(null);
    this._escHandlers = Object.create(null);
    this._oscHandlers = Object.create(null);
    this._dcsHandlers = Object.create(null);
    this._activeDcsHandler = null;
    this._errorHandler = this._errorHandlerFb;
  }

  setPrintHandler(callback: (data: string, start: number, end: number) => void): void {
    this._printHandler = callback;
  }
  clearPrintHandler(): void {
    this._printHandler = this._printHandlerFb;
  }

  setExecuteHandler(flag: string, callback: () => void): void {
    this._executeHandlers[flag.charCodeAt(0)] = callback;
  }
  clearExecuteHandler(flag: string): void {
    if (this._executeHandlers[flag.charCodeAt(0)]) delete this._executeHandlers[flag.charCodeAt(0)];
  }
  setExecuteHandlerFallback(callback: (...params: any[]) => void): void {
    this._executeHandlerFb = callback;
  }

  setCsiHandler(flag: string, callback: (params: number[], collect: string) => void): void {
    this._csiHandlers[flag.charCodeAt(0)] = callback;
  }
  clearCsiHandler(flag: string): void {
    if (this._csiHandlers[flag.charCodeAt(0)]) delete this._csiHandlers[flag.charCodeAt(0)];
  }
  setCsiHandlerFallback(callback: (...params: any[]) => void): void {
    this._csiHandlerFb = callback;
  }

  setEscHandler(collect: string, flag: string, callback: (collect: string, flag: number) => void): void {
    this._escHandlers[collect + flag] = callback;
  }
  clearEscHandler(collect: string, flag: string): void {
    if (this._escHandlers[collect + flag]) delete this._escHandlers[collect + flag];
  }
  setEscHandlerFallback(callback: (...params: any[]) => void): void {
    this._escHandlerFb = callback;
  }

  setOscHandler(ident: number, callback: (data: string) => void): void {
    this._oscHandlers[ident] = callback;
  }
  clearOscHandler(ident: number): void {
    if (this._oscHandlers[ident]) delete this._oscHandlers[ident];
  }
  setOscHandlerFallback(callback: (...params: any[]) => void): void {
    this._oscHandlerFb = callback;
  }

  setDcsHandler(collect: string, flag: string, handler: IDcsHandler): void {
    this._dcsHandlers[collect + flag] = handler;
  }
  clearDcsHandler(collect: string, flag: string): void {
    if (this._dcsHandlers[collect + flag]) delete this._dcsHandlers[collect + flag];
  }
  setDcsHandlerFallback(handler: IDcsHandler): void {
    this._dcsHandlerFb = handler;
  }

  setErrorHandler(callback: (state: IParsingState) => IParsingState): void {
    this._errorHandler = callback;
  }
  clearErrorHandler(): void {
    this._errorHandler = this._errorHandlerFb;
  }

  reset(): void {
    this.currentState = this.initialState;
    this.osc = '';
    this.params = [0];
    this.collect = '';
  }

  parse(data: string): void {
    let code = 0;
    let transition = 0;
    let error = false;
    let currentState = this.currentState;

    // local buffers
    let print = -1;
    let dcs = -1;
    let osc = this.osc;
    let collect = this.collect;
    let params = this.params;
    const table: Uint8Array | number[] = this.transitions.table;
    let dcsHandler: IDcsHandler | null = this._activeDcsHandler;
    let ident: string = '';  // ugly workaround for ESC and DCS lookup keys

    // process input string
    const l = data.length;
    for (let i = 0; i < l; ++i) {
      code = data.charCodeAt(i);

      // shortcut for most chars (print action)
      if (currentState === ParserState.GROUND && code > 0x1f && code < 0x80) {
        print = (~print) ? print : i;
        do code = data.charCodeAt(++i);
        while (i < l && code > 0x1f && code < 0x80);
        i--;
        continue;
      }

      // shortcut for CSI params
      if (currentState === ParserState.CSI_PARAM && (code > 0x2f && code < 0x39)) {
        params[params.length - 1] = params[params.length - 1] * 10 + code - 48;
        continue;
      }

      // normal transition & action lookup
      transition = (code < 0xa0) ? (table[currentState << 8 | code]) : DEFAULT_TRANSITION;
      switch (transition >> 4) {
        case ParserAction.PRINT:
          print = (~print) ? print : i;
          break;
        case ParserAction.EXECUTE:
          if (~print) {
            this._printHandler(data, print, i);
            print = -1;
          }
          if (this._executeHandlers[code]) this._executeHandlers[code]();
          else this._executeHandlerFb(code);
          break;
        case ParserAction.IGNORE:
          // handle leftover print or dcs chars
          if (~print) {
            this._printHandler(data, print, i);
            print = -1;
          } else if (~dcs) {
            dcsHandler.put(data, dcs, i);
            dcs = -1;
          }
          break;
        case ParserAction.ERROR:
          // chars higher than 0x9f are handled by this action
          // to keep the transition table small
          if (code > 0x9f) {
            switch (currentState) {
              case ParserState.GROUND:
                print = (~print) ? print : i;
                break;
              case ParserState.OSC_STRING:
                osc += String.fromCharCode(code);
                transition |= ParserState.OSC_STRING;
                break;
              case ParserState.CSI_IGNORE:
                transition |= ParserState.CSI_IGNORE;
                break;
              case ParserState.DCS_IGNORE:
                transition |= ParserState.DCS_IGNORE;
                break;
              case ParserState.DCS_PASSTHROUGH:
                dcs = (~dcs) ? dcs : i;
                transition |= ParserState.DCS_PASSTHROUGH;
                break;
              default:
                error = true;
            }
          } else {
            error = true;
          }
          // if we end up here a real error happened
          if (error) {
            let inject: IParsingState = this._errorHandler(
              {
                position: i,
                code,
                currentState,
                print,
                dcs,
                osc,
                collect,
                params,
                abort: false
              });
            if (inject.abort) return;
          // FIXME: inject return values
            error = false;
          }
          break;
        case ParserAction.CSI_DISPATCH:
          if (this._csiHandlers[code]) this._csiHandlers[code](params, collect);
          else this._csiHandlerFb(collect, params, code);
          break;
        case ParserAction.PARAM:
          if (code === 0x3b) params.push(0);
          else params[params.length - 1] = params[params.length - 1] * 10 + code - 48;
          break;
        case ParserAction.COLLECT:
          collect += String.fromCharCode(code);
          break;
        case ParserAction.ESC_DISPATCH:
          ident = collect + String.fromCharCode(code);
          if (this._escHandlers[ident]) this._escHandlers[ident](collect, code);
          else this._escHandlerFb(collect, code);
          break;
        case ParserAction.CLEAR:
          if (~print) {
            this._printHandler(data, print, i);
            print = -1;
          }
          osc = '';
          params = [0];
          collect = '';
          dcs = -1;
          break;
        case ParserAction.DCS_HOOK:
          ident = collect + String.fromCharCode(code);
          if (this._dcsHandlers[ident]) dcsHandler = this._dcsHandlers[ident];
          else dcsHandler = this._dcsHandlerFb;
          dcsHandler.hook(collect, params, code);
          break;
        case ParserAction.DCS_PUT:
          dcs = (~dcs) ? dcs : i;
          break;
        case ParserAction.DCS_UNHOOK:
          if (dcsHandler) {
            if (~dcs) dcsHandler.put(data, dcs, i);
            dcsHandler.unhook();
            dcsHandler = null;
          }
          if (code === 0x1b) transition |= ParserState.ESCAPE;
          osc = '';
          params = [0];
          collect = '';
          dcs = -1;
          break;
        case ParserAction.OSC_START:
          if (~print) {
            this._printHandler(data, print, i);
            print = -1;
          }
          osc = '';
          break;
        case ParserAction.OSC_PUT:
          osc += data.charAt(i);
          break;
        case ParserAction.OSC_END:
          if (osc && code !== 0x18 && code !== 0x1a) {
            let idx = osc.indexOf(';');
            if (idx === -1) {
              this._oscHandlerFb(-1, osc);  // this is an error (malformed OSC)
            } else {
              let identifier = parseInt(osc.substring(0, idx)); // NaN not handled here
              let content = osc.substring(idx + 1);
              if (this._oscHandlers[identifier]) this._oscHandlers[identifier](content);
              else this._oscHandlerFb(identifier, content);
            }
          }
          if (code === 0x1b) transition |= ParserState.ESCAPE;
          osc = '';
          params = [0];
          collect = '';
          dcs = -1;
          break;
      }
      currentState = transition & 15;
    }

    // push leftover pushable buffers to terminal
    if (currentState === ParserState.GROUND && ~print) {
      this._printHandler(data, print, data.length);
    } else if (currentState === ParserState.DCS_PASSTHROUGH && ~dcs && dcsHandler) {
      dcsHandler.put(data, dcs, data.length);
    }

    // save non pushable buffers
    this.osc = osc;
    this.collect = collect;
    this.params = params;

    // save active dcs handler reference
    this._activeDcsHandler = dcsHandler;

    // save state
    this.currentState = currentState;
  }
}
