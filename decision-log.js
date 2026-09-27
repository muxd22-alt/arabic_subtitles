const fs = require('fs');
const path = require('path');
const { getDecisionLogPath } = require('./config.js');

// Plain JSONL decision log — one line per per-movie decision.
// Deliberately avoids native SQLite bindings (they are fragile to build on Termux/ARM64).
function logDecision(entry, options = {}) {
    const file = options.file || getDecisionLogPath();
    const record = Object.assign({ ts: new Date().toISOString() }, entry);

    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    } catch (e) {
        console.error(`[Decision Log] Could not write to ${file}: ${e.message}`);
    }

    const bits = [];
    if (record.file) bits.push(path.basename(record.file));
    if (record.subtitle) bits.push(record.subtitle);
    if (record.action) bits.push(record.action);
    if (record.step) bits.push(record.step);
    if (record.result) bits.push(record.result);
    if (record.hits !== undefined) bits.push(`${record.hits} hit(s)`);
    if (record.language) bits.push(record.language);
    if (record.source) bits.push(record.source);
    if (record.match) bits.push(record.match);
    if (record.reason) bits.push(record.reason);
    console.log(`[Decision] ${bits.join(' | ')}`);

    return record;
}

function readDecisions(file = getDecisionLogPath()) {
    try {
        return fs.readFileSync(file, 'utf8')
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => {
                try {
                    return JSON.parse(line);
                } catch (e) {
                    return null;
                }
            })
            .filter(Boolean);
    } catch (e) {
        return [];
    }
}

module.exports = { logDecision, readDecisions };
