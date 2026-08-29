const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const wss = new WebSocketServer({ port: 5010 });
console.log('WebSocket server running on port 5010...');

// Start python with '-u' for unbuffered output to guarantee zero lag
const tracker = spawn('python', ['-u', 'track.py']);

// Read data line by line from python stdout
let buffer = '';
tracker.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    
    // Save the last incomplete line back to the buffer
    buffer = lines.pop(); 

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Forward raw text stream directly to frontend clients
        wss.clients.forEach((client) => {
            if (client.readyState === 1) { // 1 = OPEN
                client.send(trimmed);
            }
        });
    }
});

// Capture background script errors
tracker.stderr.on('data', (data) => {
    console.error(`Tracker error details: ${data}`);
});

