import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const BOT_MODE_SCHEMA_VERSION = '1.0.0';

const BOTS_DIR = () => path.join(os.homedir(), '.ox', 'bots');

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function genId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

function persistBots(cwd, bots) {
  writeJSON(path.join(cwd, 'bots.json'), bots);
}

export function createBotMode(cwd) {
  const botsFile = path.join(cwd, 'bots.json');
  const roomsFile = path.join(cwd, 'rooms.json');

  function loadBots() { return readJSON(botsFile); }
  function loadRooms() { return readJSON(roomsFile); }

  return {
    createBot(name, persona, skills = []) {
      const bots = loadBots();
      if (bots[name]) throw new Error(`Bot "${name}" exists`);
      const bot = { name, persona, skills, memory: {}, avatar: null, createdAt: Date.now() };
      bots[name] = bot;
      persistBots(cwd, bots);
      return bot;
    },
    listBots() { return Object.values(loadBots()); },
    getBot(name) { return loadBots()[name] || null; },
    removeBot(name) {
      const bots = loadBots();
      if (!bots[name]) return false;
      delete bots[name];
      persistBots(cwd, bots);
      return true;
    },
    createRoom(name, botNames = []) {
      const rooms = loadRooms();
      const id = genId();
      rooms[id] = { id, name, members: [...botNames], messages: [], createdAt: Date.now() };
      writeJSON(roomsFile, rooms);
      return rooms[id];
    },
    listRooms() { return Object.values(loadRooms()); },
    sendMessage(roomId, from, to, message) {
      const rooms = loadRooms();
      const room = rooms[roomId];
      if (!room) throw new Error(`Room ${roomId} not found`);
      const msg = { id: genId(), from, to, message, timestamp: Date.now() };
      room.messages.push(msg);
      writeJSON(roomsFile, rooms);
      return msg;
    },
    getRoomHistory(roomId) {
      const rooms = loadRooms();
      return rooms[roomId]?.messages || [];
    },
  };
}

export class BotSociety {
  constructor(cwd) {
    this.cwd = cwd;
    this.botsFile = path.join(cwd, 'bots.json');
    this.roomsFile = path.join(cwd, 'rooms.json');
    this._init();
  }
  _init() {
    this.bots = readJSON(this.botsFile);
    this.rooms = readJSON(this.roomsFile);
  }
  _save() { persistBots(this.cwd, this.bots); writeJSON(this.roomsFile, this.rooms); }
  createBot(name, persona, skills = []) {
    if (this.bots[name]) throw new Error(`Bot "${name}" exists`);
    this.bots[name] = { name, persona, skills, memory: {}, avatar: null, createdAt: Date.now() };
    this._save();
    return this.bots[name];
  }
  createRoom(name, botNames = []) {
    const id = genId();
    this.rooms[id] = { id, name, members: [...botNames], messages: [], createdAt: Date.now() };
    this._save();
    return this.rooms[id];
  }
  joinRoom(roomId, botName) {
    const room = this.rooms[roomId];
    if (!room) throw new Error(`Room ${roomId} not found`);
    if (!room.members.includes(botName)) room.members.push(botName);
    this._save();
    return room;
  }
  leaveRoom(roomId, botName) {
    const room = this.rooms[roomId];
    if (!room) throw new Error(`Room ${roomId} not found`);
    room.members = room.members.filter(m => m !== botName);
    this._save();
    return room;
  }
  messageBot(roomId, from, to, message) {
    const room = this.rooms[roomId];
    if (!room) throw new Error(`Room ${roomId} not found`);
    const msg = { id: genId(), from, to, message, timestamp: Date.now() };
    room.messages.push(msg);
    this._save();
    return msg;
  }
  broadcast(roomId, from, message) {
    const room = this.rooms[roomId];
    if (!room) throw new Error(`Room ${roomId} not found`);
    const msg = { id: genId(), from, to: null, message, timestamp: Date.now() };
    room.messages.push(msg);
    this._save();
    return msg;
  }
}
