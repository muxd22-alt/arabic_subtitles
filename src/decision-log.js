const fs = require('fs');
const path = require('path');
const { getDecisionLogPath } = require('./config.js');

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
    if (record.action) bits.push(record.action);
    if (record.source) bits.push(record.source);
    if (record.cueCount !== undefined) bits.push(`${record.cueCount} cue(s)`);
    if (record.chunks !== undefined) bits.push(`${record.chunks} chunk(s)`);
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
