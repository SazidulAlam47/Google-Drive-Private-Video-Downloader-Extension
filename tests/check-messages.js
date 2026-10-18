// Static check for message consistency between senders and handlers across the extension.

import fs from 'fs';
import path from 'path';

const ROOT_DIR = process.cwd();
const SEARCH_DIRS = ['.', 'src'];

function getJsFiles(dir) {
    const fullDir = path.join(ROOT_DIR, dir);
    if (!fs.existsSync(fullDir)) return [];
    return fs.readdirSync(fullDir)
        .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
        .map(f => path.join(fullDir, f));
}

const allFiles = SEARCH_DIRS.flatMap(getJsFiles);

const sentTypes = new Set();
const handledTypes = new Set();

const sendRegexes = [
    /sendMessage\s*\(\s*(?:[^,]+,\s*)?\{[^}]*type\s*:\s*['"]([a-zA-Z0-9_-]+)['"]/g,
    /type\s*:\s*['"]([a-zA-Z0-9_-]+)['"]/g
];

const handleRegexes = [
    /(?:message|msg)\.type\s*===?\s*['"]([a-zA-Z0-9_-]+)['"]/g,
    /case\s*['"]([a-zA-Z0-9_-]+)['"]\s*:/g
];

// Contextual search to accurately capture message sends vs handler checks
allFiles.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');

    // Find message sends
    let m;
    const sendPattern = /(?:chrome\.(?:runtime|tabs)\.sendMessage)\s*\(\s*(?:[^,]+,\s*)?\{[\s\S]*?type\s*:\s*['"]([a-zA-Z0-9_-]+)['"]/g;
    while ((m = sendPattern.exec(content)) !== null) {
        sentTypes.add(m[1]);
    }

    // Also catch report(...) in download-engine which sends downloadProgressUpdate
    if (content.includes("type: 'downloadProgressUpdate'")) {
        sentTypes.add('downloadProgressUpdate');
    }

    // Find message handlers
    handleRegexes.forEach(regex => {
        let h;
        while ((h = regex.exec(content)) !== null) {
            handledTypes.add(h[1]);
        }
    });
});

console.log('--- Message Consistency Check ---');
console.log('Messages sent:', Array.from(sentTypes).sort());
console.log('Messages handled:', Array.from(handledTypes).sort());

// Intentional exceptions list
const intentionalSentWithoutHandler = [];
const intentionalHandledWithoutSender = [];

const unhandledSent = Array.from(sentTypes).filter(t => !handledTypes.has(t) && !intentionalSentWithoutHandler.includes(t));
const unusedHandled = Array.from(handledTypes).filter(t => !sentTypes.has(t) && !intentionalHandledWithoutSender.includes(t));

let hasError = false;

if (unhandledSent.length > 0) {
    console.error('ERROR: The following message types are sent but have no handler:');
    unhandledSent.forEach(t => console.error('  - ' + t));
    hasError = true;
}

if (unusedHandled.length > 0) {
    console.warn('NOTE: The following message types have handlers but were not found in senders:');
    unusedHandled.forEach(t => console.warn('  - ' + t));
    // If not intentional, treat as warning or error
}

if (!hasError) {
    console.log('SUCCESS: All sent messages have corresponding handlers.');
    process.exit(0);
} else {
    process.exit(1);
}
