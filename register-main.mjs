#!/usr/bin/env node
// Registers the first discovered Slack channel as the main group.
// Run this AFTER NanoClaw has started and synced channel metadata.
// Usage: node register-main.mjs [channel-name]

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const storePath = path.join(process.cwd(), 'store', 'messages.db');
if (!fs.existsSync(storePath)) {
  console.error('ERROR: store/messages.db not found. Start NanoClaw first.');
  process.exit(1);
}

const db = new Database(storePath);

// Find channels
const chats = db.prepare('SELECT * FROM chats WHERE is_group = 1').all();
if (chats.length === 0) {
  console.error('No channels discovered yet. Send a message in a channel the bot is in, then retry.');
  process.exit(1);
}

console.log('Discovered channels:');
for (const c of chats) {
  console.log(`  ${c.jid}  (name: ${c.name || '?'})`);
}

// Pick the target channel
const targetName = process.argv[2] || 'swarm-main';
let target = chats.find(c => c.name?.includes(targetName));
if (!target && chats.length === 1) {
  target = chats[0];
}
if (!target) {
  console.error(`Channel matching "${targetName}" not found. Specify the name as argument.`);
  process.exit(1);
}

console.log(`\nRegistering ${target.jid} (${target.name}) as main group...`);

// Check if already registered
const existing = db.prepare('SELECT * FROM registered_groups WHERE jid = ?').get(target.jid);
if (existing) {
  console.log('Already registered:', existing);
  process.exit(0);
}

// Register
const folder = 'slack_swarm-main';
const triggerPattern = '@swarm';
const now = new Date().toISOString();

db.prepare(
  `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
).run(target.jid, target.name || 'swarm-main', folder, triggerPattern, now, null, 0, 1);

// Create group folder
const groupDir = path.join(process.cwd(), 'groups', folder, 'logs');
fs.mkdirSync(groupDir, { recursive: true });

console.log('Main group registered successfully!');
console.log(`  JID: ${target.jid}`);
console.log(`  Folder: groups/${folder}/`);
console.log(`  Trigger: ${triggerPattern}`);
console.log(`  isMain: true`);
console.log(`  requiresTrigger: false (main group responds to all messages)`);
console.log('\nRestart NanoClaw to pick up the registration.');

db.close();
