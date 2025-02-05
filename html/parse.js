

// Configuration data
const config = new Array(160*71);
// Raw bitstream, sequence of 160*71 0/1 values
let rawBitstream = new Array(160*71);
// Bitstream in table format, matching die layout
var bitstreamTable = null;

/**
 * Parse configuration file
 * Store in array config, where config[n] = type and n = bit position
 */
function loadConfig(callback) {
  let defs = new Array(160);
  window.defs = defs;
  for (let x = 0; x < 160; x++) {
    defs[x] = new Array(71);
  }
  $.get('XC2064-def.txt', function(data) {
    const lines = data.match(/[^\r\n]+/g);
    lines.forEach(function(l) {
      const m = l.match(/Bit:\s+(\S+)\s+(.*)/);
      if (m) {
        const addr = parseInt(m[1], 16);
        const val = m[2];
        config[addr] =val;
      }
    });
    // Done, call callback to continue initialization
    callback();
  }, 'text');
}


/**
 * Handles the upload of a .RBT file, storing it into the variable rawBitstream, which has 160 lines of 71 '0'/'1' characters,
 * the contents of the .RBT file.
 */
function rbtParse(contents) {
  rawBitstream = parseRbtFile(contents);
  bitstreamTable = makeBitstreamTable(rawBitstream);
}

/**
 * Splits the RBT file into lines, removing headers.
 * erturns rawBitstream
 */
function parseRbtFile(contents) {
  let lines = contents.split(/[\r\n]+/);
  let mode = 'header';
  let idx = 0; // Index into rawBitstream
  for (let i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (mode == 'header') {
      if (line.startsWith('0') && line.endsWith('111')) {
        mode = 'data';
      }
    }
    if (mode == 'data') {
      if (line.startsWith('1111')) {
        mode = 'done';
      } else if (line.startsWith('0') && line.endsWith('111')) {
        mode = 'data';
        var data = line.slice(1, -3);
        if (data.length != 71) {
          alert('Bad line length ' + data.length + ' in .RBT file');
          return;
        }
        for (let i = 0; i < 71; i++) {
          rawBitstream[idx++] = data[i] == '1' ? 1 : 0;
        }
      } else {
        alert('Bad data line in .RBT file');
        return;
      }
    }
  }
  if (idx != 160 * 71) {
    alert('Wrong number of bits ' + idx + ' in .RBT file');
    return;
  }
  return rawBitstream;
}

/**
 * The RBT file is organized:
 * HH ... AH
 * .       .
 * HA ... AA
 * stored as rbtLines[line][char] of '0' and '1'.
 *
 * The die is organized:
 * AA ... AH
 * .       .
 * HA ... HH
 * This function flips the rbtLines to match the die, stored as bitstreamTable[x][y].
 * I'm using the term "bitstreamTable" to describe the bitstreamTable with the die's layout and "rbtLines" to describe the bitstreamTable
 * with the .RBT file's layout.
 * Note: this bitstream is inverted with respect to the RBT file: a 0 entry is converted to active 1.
 */
function makeBitstreamTable(rawBitstream) {
  var bitstreamTable = new Array(160);
  for (var x = 0; x < 160; x++) {
    bitstreamTable[x] = new Array(71);
    for (var y = 0; y < 71; y++) {
      bitstreamTable[x][y] = rawBitstream[(159 - x) * 71 + (70 - y)] ? 0 : 1;
    }
  }
  return bitstreamTable;
}

/*
 * The model for a decoder is:
 * startDecode() is called to initialize.
 * add() is called to add bits as they are parsed from the XC2064-def.txt file.
 * decode() is called at the end to complete the decoding.
 */

let bitTypes;
function decode(rawBitstream, config) {
  bitTypes = new Array(160 * 71);
  decoders.forEach(d => d.startDecode());
  for (let i = 0; i < 160 * 71; i++) {
    let entry = config[i];
    if (entry == undefined || entry == "----- NOT USED -----") {
      bitTypes[i] = BITTYPE.unused;
      continue;
    }
    let m = entry.match(/IOB (P\d+)(.*)/);
    if (m) {
      bitTypes[i] = BITTYPE.iob;
      iobDecoders.getFromPin(m[1]).add(m[2], rawBitstream[i]);
      continue;
    }
    m = entry.match(/PIP\s+(.*)/);
    if (m) {
      bitTypes[i] = BITTYPE.pip;
      pipDecoder.add(m[1], rawBitstream[i]);
      continue;
    }
    m = entry.match(/Bidi\s+(.*)/);
    if (m) {
      bitTypes[i] = BITTYPE.bidi;
      bidiDecoder.add(m[1], rawBitstream[i]);
      continue;
    }
    m = entry.match(/Magic @ (\S+) (\d) (\d)$/);
    if (m) {
      bitTypes[i] = BITTYPE.switch;
      if (rawBitstream[i] != 1) {
        switchDecoders.getFromG(m[1]).add(parseInt(m[2]), parseInt(m[3]));
      }
      continue;
    }
    m = entry.match(/CLB ([A-H][A-H])\s*(.*)/);
    if (m) {
      if (entry.match(/Logic Table/)) {
        bitTypes[i] = BITTYPE.lut;
      } else {
        bitTypes[i] = BITTYPE.clb;
      }
      clbDecoders.get(m[1]).add(m[2], rawBitstream[i]);
      continue;
    }
    m = entry.match(/CLB (CLK.[AI][AI].I)\s*(.*)/);
    if (m) {
      bitTypes[i] = BITTYPE.clb;
      clbDecoders.get(m[1]).add(m[2], rawBitstream[i]);
      continue;
    }
    m = entry.match(/Other (.*)/);
    if (m) {
      bitTypes[i] = BITTYPE.other;
      otherDecoder.add(m[1], rawBitstream[i]);
      continue;
    }
    console.log('UNKNOWN:', entry);
  }
  decoders.forEach(d => d.decode());
}

var iobDecoders;
var pipDecoder;
var clbDecoders;
var otherDecoder;
var switchDecoders;
var bidiDecoder;
let decoders = [];
function initDecoders() {
  iobDecoders = new IobDecoders();
  pipDecoder = new PipDecoder();
  bidiDecoder = new BidiDecoder();
  otherDecoder = new OtherDecoder();
  clbDecoders = new ClbDecoders;
  switchDecoders = new SwitchDecoders();
  decoders = [iobDecoders, pipDecoder, bidiDecoder, otherDecoder, clbDecoders, switchDecoders];
  decoders.forEach(d => d.startDecode());
}

class ClkDecoder {
  constructor(name) {
    this.name = name;
  }

  startDecode() {
  }

  add(str) {
  }

  decode() {
  }

  render(ctx) {
  }
}

class PipDecoder {
  constructor() {
    this.entries = {};
  }

  startDecode() {
    this.entries = {};
  }

  add(str, bit) {
    this.entries[str] = bit;
  }

  decode() {}

  // Is it better to separate the parsing code and the rendering code
  // or to fold it into one class?
  // For now, separate functions, but called from inside the class.
  render(ctx) {
    pipRender(ctx, this.entries);
  }
}

class BidiDecoder {
  constructor() {
    this.entries = {};
  }

  startDecode() {
    this.entries = {};
  }

  add(str, bit) {
    this.entries[str] = bit;
  }

  decode() {}

  render(ctx) {
  }
}

class SwitchDecoders {
  constructor() {
    this.switches = {};
    this.switchesFromG = {};
    for (let i = 0; i < 9; i++) {
      for (let j = 0; j < 9; j++) {
        if ((i == 0) && (j == 0 || j == 8)) continue; // Top corners
        if ((i == 8) && (j == 0 || j == 8)) continue; // Bottom corners
        for (let num = 1; num <= 2; num++) {
          const name = "ABCDEFGHI"[i] + "ABCDEFGHI"[j] + ".8." + num;
          const sw = new Switch(name);
          this.switches[name] = sw;
          this.switchesFromG[sw.gPt[0] + "G" + sw.gPt[1]] = sw;
        }
      }
    }
  }

  startDecode() {
    Object.entries(this.switches).forEach(([k, s]) => s.startDecode());
  }

  getFromG(name) {
    return this.switchesFromG[name];
  }

  get(name) {
    return this.switches[name];
  }

  decode() {}

  render(ctx) {
    Object.entries(this.switches).forEach(([name, obj]) => obj.render(ctx));
  }

}


  /**
   * Converts a symbolic name to G coordinates.
   */
  function nameToG(str) {
    if (str.includes("PAD")) {
      return IobDecoders.nameToG[str];
    }
    const m = str.match(/([A-I][A-I])\.8\.(\d)\.(\d)$/);
    if (str.match(/([A-I][A-I])\.8\.(\d)\.(\d)$/)) {
      return getSwitchCoords(str)[0];
    }
    const parts = str.split(':');
    const col = colInfo[parts[0]];
    const row = rowInfo[parts[1]];
    if (col == undefined || row == undefined) {
      console.log("Couldn't convert name", str);
      return;
    }
    return col[0] + "G" + row[0];
  }

  /**
   * Converts G coordinates to a symbolic name.
   */
  function gToName(str) {
    if (IobDecoders.gToName[str]) {
      return IobDecoders.gToName[str];
    }
    const parts = str.split('G');
    const col = colFromG[parts[0]];
    const row = rowFromG[parts[1]];
    if (col == undefined || row == undefined) {
      console.log("Couldn't convert name", str);
      return;
    }
    return col + ":" + row;
  }


class OtherDecoder {
  constructor() {
  }

  startDecode() {
    this.input = "";
    this.donepad = "";
    this.read = "";
    this.unk = "";
    this.entries = {};
  }

  add(str, bit) {
    this.entries[str] = bit;
  }

  decode() {
    this.input = this.entries["TTL/CMOS level Inputs"] ? "TTL" : "CMOS";
    if (this.entries["Single/Unlimited FPGA readback if readback enabled"]) {
      this.read = this.entries["FPGA readback Enabled/Disable"] ? "0" : "1";
    } else {
      this.read = "CMD";
    }
    this.donepad = this.entries["DONE pin Pullup/No Pullup"] ? "NOPULLUP" : "PULLUP";
    const unk = "" + this.entries["UNknown 1"] + this.entries["UNknown 2"] + this.entries["UNknown 3"] + this.entries["UNknown 4"];
    if (unk != "1011") {
      this.unk = "Unknown: " + unk;
    }
  }

  info() {
    return this.input + " " + this.donepad + " " + this.read + " " + this.unk;
  }

  render(ctx) {
  }
}


const BITTYPE = Object.freeze({lut: 1, clb: 2, pip: 3, switch: 5, iob: 6, bidi: 7, other: 8, unused: 9});
  class PipDecode {
    constructor(name, bitPt) {
      this.name = name;
      var parts = name.split(':');
      if (colInfo[parts[0]] == undefined || rowInfo[parts[1]] == undefined) {
        alert('undefined name ' + name);
      }
      this.screenPt = [colInfo[parts[0]][1], rowInfo[parts[1]][1]];
      if (this.screenPt[0] == 999 || this.screenPt[1] == 999) {
        alert('Undefined coord ' + name);
      }
      this.bitPt = bitPt;
      if (bitPt[0] >= 160 || bitPt[1] >= 71) {
        alert('Out of bounds bitstreamTable index: ' + bitPt[0] + ',' + bitPt[1]);
      }
      this.state = 0;

    }

    decode(bitstreamTable) {
      if (this.bitPt[0] < 0) {
        this.state = -1;
      } else {
        this.state = bitstreamTable[this.bitPt[0]][this.bitPt[1]];
      }
    }

    /**
     * Returns the function of each (known) bit in the bitstreamTable.
     *
     * Format: [[x, y, type], ...]
     */
    getBitTypes() {
      return [[this.bitPt[0], this.bitPt[1], BITTYPE.pip]];
    }
  }

  // There are 9 types of tiles depending on if they are along an edge. (Think of a tic-tac-toe grid.) Most will be the center type.
  // Maybe we could make 9 subclasses for everything, but for now I'll hardcode types in the code.
  const TILE = Object.freeze({ul: 1, top: 2, ur: 3, left: 4, center: 5, right: 6, ll: 7, bottom: 8, lr: 9});

  function tileType(x, y) {
    if (y == 0) {
      if (x == 0) {
        return TILE.ul;
      } else if (x < 8) {
        return TILE.top;
      } else if (x == 8) {
        return TILE.ur;
      }
    } else if (y < 8) {
      if (x == 0) {
        return TILE.left;
      } else if (x < 8) {
        return TILE.center;
      } else if (x == 8) {
        return TILE.right;
      }
    } else if (y == 8) {
      if (x == 0) {
        return TILE.ll;
      } else if (x < 8) {
        return TILE.bottom;
      } else if (x == 8) {
        return TILE.lr;
      }
    }
    throw "unexpected";
  }

  class TileDecode {
    constructor(x, y) {
      this.x = x; // Index 0-8
      this.y = y;
      this.name = "ABCDEFGHI"[y] + "ABCDEFGHI"[x];
      this.screenPt = [x * 72 + 78, y * 72 + 68];
      this.gPt = [x * 19, y * 20];
      this.bitPt = [xTileStarts[x], yTileStarts[y]];
      this.pips = [];
      this.pins = [];
      if (x < 8 && y < 8) {
        this.clb = new Clb(x, y, [x * 72 + 78, y * 72 + 68], [x * 19, y * 20], this.bitPt);
      } else {
        this.clb = null;
      }
      this.type = tileType(x, y);

      var row = "ABCDEFGHI"[y];
      var col = "ABCDEFGHI"[x];
      // Substitute for ROW and COL in the pip name
      function rename(pip) {
        return pip.replace('ROW', row).replace('COL', col);
      }

      // For a repeated tile, the pip location is relative to the origin for tile BB. The x and y will need to shift based on the row/column.
      // (The pip location could be given relative to the start of tile BB, but it's not.)
      // This shift is not constant because of the buffers.
      // For non-repeated tiles, the pip does not need to be adjusted.
      // 
      var xoffset = xTileStarts[x] - xTileStarts[1]; // xoffset == 0 for tile B
      var yoffset = yTileStarts[y] - yTileStarts[1]; // xoffset == 0 for tile B

      this.switch1 = null;
      this.switch2 = null;
      if (this.type == TILE.ul) {

        // Name of pip and corresponding bitmap entry
        var pips = [
          ["col.A.long.2:row.A.long.2", [6, 3]], ["col.A.local.1:row.A.long.2", [7, 3]], ["col.A.long.3:row.A.long.2", [12, 1]],
          ["col.A.long.2:row.A.local.1", [9, 3]], ["col.A.local.1:row.A.local.1", [8, 3]],
          ["col.A.local.2:row.A.local.2", [12, 3]],
          ["col.A.local.3:row.A.local.3", [14, 3]], ["col.A.long.4:row.A.local.3", [17, 0]],
          ["col.A.local.4:row.A.local.4", [20, 3]],
          ["col.A.local.4:row.A.long.3", [20, 1]], ["col.A.long.3:row.A.long.3", [13, 3]], ["col.A.long.4:row.A.long.3", [16, 3]]];
        pips.forEach(pip => this.pips.push(new Pip(rename(pip[0]), pip[1])));
      } else if (this.type == TILE.top) {
        var pips = [
          ["col.COL.long.1:row.A.long.2", [30, 1]],
          ["col.COL.long.2:row.A.local.1", [33, 3]],
          ["col.COL.local.5:row.A.local.2", [28, 3]], ["col.COL.long.1:row.A.local.2", [31, 2]],
          ["col.COL.local.5:row.A.local.3", [29, 2]], ["col.COL.long.2:row.A.local.3", [35, 0]],
          ["col.COL.long.1:row.A.local.4", [33, 2]],
          ["col.COL.local.1:row.A.long.3", [23, 2]], ["col.COL.local.4:row.A.long.3", [38, 1]], ["col.COL.long.1:row.A.long.3", [32, 2]], ["col.COL.long.2:row.A.long.3", [32, 3]]];

        this.switch1 = new Switch(this, 1);
        this.switch2 = new Switch(this, 2);

        pips.forEach(pip => this.pips.push(new Pip(rename(pip[0]), [pip[1][0] + xoffset, pip[1][1]])));

      } else if (this.type == TILE.ur) {
        var pips = [
          ["col.I.local.4:row.A.long.2", [152, 4]], ["col.I.long.3:row.A.long.2", [153, 4]],
          ["col.I.local.0:row.A.local.1", [-1, -1]], ["col.I.local.4:row.A.local.1", [151, 2]], ["col.I.long.3:row.A.local.1", [152, 2]],
          ["col.I.local.0:row.A.local.2", [-1, -1]], ["col.I.local.3:row.A.local.2", [155, 4]],
          ["col.I.local.0:row.A.local.3", [-1, -1]], ["col.I.local.2:row.A.local.3", [157, 4]],
          ["col.I.local.1:row.A.local.4", [156, 4]], ["col.I.local.0:row.A.local.4", [-1, -1]],
          ["col.I.local.0:row.A.long.3", [-1, -1]], ["col.I.long.1:row.A.long.3", [154, 2]], ["col.I.long.2:row.A.long.3", [153, 2]],
          ["col.I.long.2:row.A.local.5", [-1, -1]], ["col.I.local.1:row.A.local.5", [-1, -1]], ["col.I.local.2:row.A.local.5", [-1, -1]],  ["col.I.local.3:row.A.local.5", [-1, -1]],  ["col.I.local.4:row.A.local.5", [-1, -1]]];
        pips.forEach(pip => this.pips.push(new Pip(rename(pip[0]), pip[1])));

        // pins.push(new Iob(11, 58, 'left'));
        // pins.push(new Iob(9, 1, 'top'));
        // pins.push(new Iob(8, 2, 'top'));
      } else if (this.type == TILE.left) {
        var pips = [
          ["col.A.long.3:row.ROW.local.1", [9, 11]],
          ["col.A.long.4:row.ROW.local.3", [11, 11]],
          ["col.A.long.2:row.ROW.long.1", [5, 11]], ["col.A.local.1:row.ROW.long.1", [4, 11]], ["col.A.local.4:row.ROW.long.1", [17, 11]], ["col.A.long.3:row.ROW.long.1", [10, 11]], ["col.A.long.4:row.ROW.long.1", [15, 11]]];
        this.switch1 = new Switch(this, 1);
        this.switch2 = new Switch(this, 2);
        pips.forEach(pip => this.pips.push(new Pip(rename(pip[0]), [pip[1][0], pip[1][1] + yoffset])));
      } else if (this.type == TILE.center) {
        var pips = [
          ["col.COL.local.5:row.ROW.local.0", [23, 11]],
          ["col.COL.long.2:row.ROW.local.1", [32, 11]],
          ["col.COL.local.5:row.ROW.local.3", [24, 11]], ["col.COL.local.6:row.ROW.local.3", [27, 11]], ["col.COL.long.1:row.ROW.local.3", [28, 11]],
          ["col.COL.local.5:row.ROW.local.4", [25, 11]], ["col.COL.local.6:row.ROW.local.4", [26, 11]], ["col.COL.long.2:row.ROW.local.4", [33, 11]],
          ["col.COL.long.1:row.ROW.local.5", [31, 11]],
          ["col.COL.local.1:row.ROW.long.1", [22, 11]], ["col.COL.local.4:row.ROW.long.1", [35, 11]]];
        // Main part
        this.switch1 = new Switch(this, 1);
        this.switch2 = new Switch(this, 2);
        pips.forEach(pip => this.pips.push(new Pip(rename(pip[0]), [pip[1][0] + xoffset, pip[1][1] + yoffset])));
      } else if (this.type == TILE.right) {
        var pips = [
          ["col.I.long.2:row.ROW.local.1", [159, 11]],
          ["col.I.long.1:row.ROW.local.3", [153, 11]],
          ["col.I.long.2:row.ROW.local.4", [153, 12]],
          ["col.I.long.1:row.ROW.local.5", [154, 12]],
          ["col.I.long.1:row.ROW.long.1", [154, 11]], ["col.I.long.2:row.ROW.long.1", [158, 11]], ["col.I.local.1:row.ROW.long.1", [155, 11]], ["col.I.local.4:row.ROW.long.1", [151, 11]], ["col.I.long.3:row.ROW.long.1", [152, 11]]];
        this.switch1 = new Switch(this, 1);
        this.switch2 = new Switch(this, 2);
        pips.forEach(pip => this.pips.push(new Pip(rename(pip[0]), [pip[1][0], pip[1][1] + yoffset])));
      } else if (this.type == TILE.ll) {
        // bottom left
        var pips = [
          ["col.A.local.1:row.I.local.0", [-1, -1]], ["col.A.local.2:row.I.local.0", [-1, -1]], ["col.A.local.3:row.I.local.0", [-1, -1]], ["col.A.local.4:row.I.local.0", [-1, -1]], ["col.A.long.3:row.I.local.0", [-1, -1]],
          ["col.A.local.4:row.I.long.1", [20, 69]], ["col.A.long.3:row.I.long.1", [13, 67]], ["col.A.long.4:row.I.long.1", [16, 67]], ["col.A.local.5:row.I.long.1", [-1, -1]],
          ["col.A.local.4:row.I.local.1", [20, 67]], ["col.A.local.5:row.I.local.1", [-1, -1]],
          ["col.A.local.3:row.I.local.2", [14, 67]], ["col.A.long.4:row.I.local.2", [17, 70]], ["col.A.local.5:row.I.local.2", [-1, -1]],
          ["col.A.local.2:row.I.local.3", [12, 67]], ["col.A.local.5:row.I.local.3", [-1, -1]],
          ["col.A.long.2:row.I.local.4", [9, 67]], ["col.A.local.1:row.I.local.4", [8, 67]], ["col.A.local.5:row.I.local.4", [-1, -1]],
          ["col.A.long.2:row.I.long.2", [6, 67]], ["col.A.local.1:row.I.long.2", [7, 67]], ["col.A.long.3:row.I.long.2", [12, 69]]];
        pips.forEach(pip => this.pips.push(new Pip(rename(pip[0]), pip[1])));
      } else if (this.type == TILE.bottom) {
        var pips = [
          ["col.COL.local.1:row.I.long.1", [23, 68]], ["col.COL.local.4:row.I.long.1", [38, 69]], ["col.COL.long.1:row.I.long.1", [32, 68]], ["col.COL.long.2:row.I.long.1", [32, 67]],
          ["col.COL.long.1:row.I.local.1", [33, 68]],
          ["col.COL.local.5:row.I.local.2", [29, 68]], ["col.COL.long.2:row.I.local.2", [35, 70]],
          ["col.COL.local.5:row.I.local.3", [28, 67]], ["col.COL.long.1:row.I.local.3", [31, 68]],
          ["col.COL.long.2:row.I.local.4", [33, 67]],
          ["col.COL.long.1:row.I.long.2", [30, 69]]];
        this.switch1 = new Switch(this, 1);
        this.switch2 = new Switch(this, 2);
        pips.forEach(pip => this.pips.push(new Pip(rename(pip[0]), [pip[1][0] + xoffset, pip[1][1]])));
      } else if (this.type == TILE.lr) {
        // bottom right
        var pips = [
          ["col.I.long.1:row.I.long.1", [155, 67]], ["col.I.long.2:row.I.long.1", [158, 67]],
          ["col.I.local.1:row.I.local.1", [156, 67]],
          ["col.I.local.2:row.I.local.2", [157, 67]],
          ["col.I.local.3:row.I.local.3", [154, 67]],
          ["col.I.local.4:row.I.local.4", [151, 68]], ["col.I.long.3:row.I.local.4", [152, 67]],
          ["col.I.local.4:row.I.long.2", [151, 67]], ["col.I.long.3:row.I.long.2", [153, 67]]];
        pips.forEach(pip => this.pips.push(new Pip(rename(pip[0]), pip[1])));
      }
    }

    /**
     * Decode this tile from the bitstreamTable.
     * Returns string.
     */
    decode(bitstreamTable) {
      var result = ['tile info'];
      if (this.clb) {
        result.push(this.clb.decode(bitstreamTable));
      }
      if (this.switch1 != null) {
        result.push(this.switch1.decode(bitstreamTable));
        result.push(this.switch2.decode(bitstreamTable));
      }
      this.pips.forEach(pip => result.push(pip.decode(bitstreamTable)));
      this.pins.forEach(pin => result.push(pin.decode(bitstreamTable)));
      return result;
    }

    /**
     * Returns the function of each (known) bit in the bitstreamTable.
     *
     * Format: [[x, y, type], ...]
     */
    getBitTypes() {
      let result = [];
      if (this.clb) {
        result.push(...this.clb.getBitTypes(bitstreamTable));
      }
      if (this.switch1 != null) {
        result.push(...this.switch1.getBitTypes(bitstreamTable));
        result.push(...this.switch2.getBitTypes(bitstreamTable));
      }
      this.pips.forEach(pip => result.push(...pip.getBitTypes(bitstreamTable)));
      this.pins.forEach(pin => result.push(...pin.getBitTypes(bitstreamTable)));
      return result;
    }
  }

  /**
   * A switch matrix.
   * Coordinates: screenPt is the upper left corner of the box. gPt is the coordinate of pin 8.
   */
  class XXXSwitchDecode {
    constructor(tile, num) {
      this.tile = tile; // Back pointer to enclosing tile.
      this.num = num; // 1 or 2
      this.name = tile.name + '.8.' + num;
      this.state = null;
      this.wires = [];

      // The switch pair's upper left wires are local.1
      var row = rowInfo['row.' + this.tile.name[0] + '.local.1'];
      var col = colInfo['col.' + this.tile.name[1] + '.local.1'];
      if (this.tile.type == TILE.bottom) {
        // The bottom switches are mirror-imaged, inconveniently.
        if (num == 1) {
          this.gPt = [col[0] + 3, row[0] + 1];
          this.screenPt = [col[1] - 2, row[1] + 6];
        } else {
          this.gPt = [col[0], row[0] - 2];
          this.screenPt = [col[1] - 2 + 8, row[1] + 6 - 8];
        }
      } else {
        if (num == 1) {
          this.gPt =[col[0], row[0] + 1]
          this.screenPt = [col[1] - 2, row[1] - 2];
        } else {
          this.gPt = [col[0] + 3, row[0] - 2];
          this.screenPt = [col[1] - 2 + 8, row[1] - 2 + 8];
        }
      }
    }

    /**
     * Returns (x, y) screen coordinate for the pin.
     */
    pinCoord(pin) {
        return [this.screenPt[0] + [2, 6, 9, 9, 6, 2, 0, 0][pin],
                this.screenPt[1] + [0, 0, 2, 6, 9, 9, 6, 2][pin]];
    }

    /**
     * Draws the internal wire between pin1 and pin2.
     */
    drawWires(ctx) {
      ctx.beginPath();
      const self = this;
      ctx.strokeStyle = 'blue';
      this.wires.forEach(function([pin1, pin2]) {
        var coord1 = self.pinCoord(pin1);
        var coord2 = self.pinCoord(pin2);
        ctx.moveTo(coord1[0], coord1[1]);
        ctx.lineTo(coord2[0], coord2[1]);
      });
      ctx.stroke();
      
    }

    isInside(x, y) {
      return x >= this.screenPt[0] && x < this.screenPt[0] + 8 && y >= this.screenPt[1] && y < this.screenPt[1] + 8;
    }

    // Helper to remove pins from switches along edges.
    skip(pin) {
      return ((this.tile.type == TILE.top && (pin == 0 || pin == 1)) || (this.tile.type == TILE.bottom && (pin == 4 || pin == 5)) ||
          (this.tile.type == TILE.left && (pin == 6 || pin == 7)) || (this.tile.type == TILE.right && (pin == 2 || pin == 3)));
    }

    decode(bitstreamTable) {

      // bits is a list of [[bitstreamTable x, bitstreamTable y], [pin 1, pin 2]], where the bitstreamTable coordinates are relative to the tile edge.
      if (this.tile.type == TILE.top && this.num == 1) {
        var bits = [[[0, 1], [3, 7]], [[1, 1], [5, 6]], [[3, 1], [2, 7]], [[4, 1], [2, 6]], [[5, 1], [2, 4]], [[0, 2], [5, 7]], [[1, 2], [3, 6]], [[2, 2], [3, 5]], [[4, 2], [4, 6]], [[5, 2], [3, 4]]];
      } else if (this.tile.type == TILE.top && this.num == 2) {
        var bits = [[[13, 2], [3, 7]], [[14, 2], [3, 6]], [[15, 2], [3, 5]], [[16, 2], [4, 6]], [[17, 2], [2, 4]], [[13, 1], [5, 7]], [[14, 1], [5, 6]], [[15, 1], [2, 7]], [[16, 1], [2, 6]], [[17, 1], [3, 4]]];
      } else if (this.tile.type == TILE.left && this.num == 1) {
        var bits = [[[1, 0], [0, 5]], [[2, 0], [3, 5]], [[3, 0], [1, 5]], [[4, 0], [0, 4]], [[5, 0], [1, 4]], [[6, 0], [1, 2]], [[7, 0], [2, 4]], [[8, 0], [3, 4]], [[9, 0], [1, 3]], [[3, 2], [0, 2]]];
      } else if (this.tile.type == TILE.left && this.num == 2) {
        var bits = [[[9, 2], [1, 3]], [[16, 2], [0, 4]], [[14, 0], [1, 5]], [[15, 0], [2, 4]], [[16, 0], [0, 5]], [[17, 0], [3, 5]], [[14, 1], [1, 2]], [[15, 1], [1, 4]], [[16, 1], [0, 2]], [[17, 1], [3, 4]]];
      } else if (this.tile.type == TILE.center && this.num == 1) {
        var bits = [[[0, 0], [0, 6]], [[1, 0], [0, 7]], [[2, 0], [2, 6]], [[3, 0], [2, 7]], [[4, 0], [0, 4]], [[5, 0], [1, 5]], [[6, 0], [1, 2]], [[7, 0], [3, 4]], [[8, 0], [3, 5]], [[0, 1], [5, 6]], [[1, 1], [3, 7]], [[2, 1], [3, 6]], [[3, 1], [1, 7]], [[4, 1], [4, 6]], [[5, 1], [1, 4]], [[6, 1], [1, 3]], [[7, 1], [2, 4]], [[8, 1], [0, 5]], [[0, 2], [5, 7]], [[8, 2], [0, 2]]];
      } else if (this.tile.type == TILE.center && this.num == 2) {
        var bits = [[[9, 0], [4, 6]], [[10, 0], [5, 6]], [[11, 0], [0, 7]], [[12, 0], [0, 4]], [[13, 0], [1, 5]], [[14, 0], [2, 7]], [[15, 0], [3, 7]], [[16, 0], [1, 2]], [[17, 0], [1, 3]], [[9, 1], [1, 4]], [[10, 1], [5, 7]], [[11, 1], [0, 6]], [[12, 1], [0, 5]], [[13, 1], [3, 5]], [[14, 1], [0, 2]], [[15, 1], [3, 6]], [[16, 1], [2, 6]], [[17, 1], [3, 4]], [[9, 2], [1, 7]], [[16, 2], [2, 4]]];
      } else if (this.tile.type == TILE.right && this.num == 1) {
        var bits = [[[5, 0], [1, 5]], [[6, 0], [0, 4]], [[7, 0], [1, 7]], [[8, 0], [4, 6]], [[5, 1], [0, 5]], [[6, 1], [1, 4]], [[7, 1], [0, 7]], [[8, 1], [0, 6]], [[5, 2], [5, 6]], [[6, 2], [5, 7]]];
      } else if (this.tile.type == TILE.right && this.num == 2) {
        var bits = [[[0, 0], [1, 7]], [[1, 0], [0, 4]], [[2, 0], [0, 7]], [[3, 0], [0, 5]], [[4, 0], [0, 6]], [[0, 1], [1, 4]], [[1, 1], [4, 6]], [[2, 1], [5, 7]], [[3, 1], [1, 5]], [[4, 1], [5, 6]]];
      } else if (this.tile.type == TILE.bottom && this.num == 1) {
        var bits = [[[0, 0], [0, 6]], [[1, 0], [2, 7]], [[2, 0], [0, 2]], [[4, 0], [1, 7]], [[5, 0], [1, 2]], [[0, 1], [2, 6]], [[1, 1], [0, 7]], [[3, 1], [3, 6]], [[4, 1], [3, 7]], [[5, 1], [1, 3]]];
      } else if (this.tile.type == TILE.bottom && this.num == 2) {
        var bits = [[[13, 0], [2, 6]], [[14, 0], [2, 7]], [[15, 0], [0, 2]], [[16, 0], [1, 7]], [[17, 0], [1, 3]], [[13, 1], [0, 6]], [[14, 1], [0, 7]], [[15, 1], [3, 6]], [[16, 1], [3, 7]], [[17, 1], [1, 2]]];
      } else {
        throw "Bad switch";
      }

      this.wires = [];
      const self = this;
      bits.forEach(function([[btX, btY], wire]) {
        if (bitstreamTable[self.tile.bitPt[0] + btX][self.tile.bitPt[1] + btY] == 1) {
          self.wires.push(wire);
        }
      });

      this.bitTypes = []
      bits.forEach(function([[btX, btY], wire]) {
        self.bitTypes.push([self.tile.bitPt[0] + btX, self.tile.bitPt[1] + btY, BITTYPE.switch]);
      });
    }

    /**
     * Returns the function of each (known) bit in the bitstreamTable.
     *
     * Format: [[x, y, type], ...]
     */
    getBitTypes() {
      return this.bitTypes;
    }

    info() {
      return "Switch " + this.state + " " + this.wires;
    }
  }

  function initParser() {
    initNames();
    initDecoders();
  }
