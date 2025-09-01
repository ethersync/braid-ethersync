#!/usr/bin/env node

const http = require('http');
const {EventSource} = require('eventsource');

class EthersyncProxy {
  constructor() {
    this.buffer = '';
    this.expectedLength = null;
    this.sseConnection = null;
  }

  start() {
    // Set up stdin reading
    process.stdin.setEncoding('utf8');
    
    process.stdin.on('data', (chunk) => {
      this.buffer += chunk;
      this.processBuffer();
    });

    process.stdin.on('end', () => {
      if (this.sseConnection) {
        this.sseConnection.close();
      }
      process.exit(0);
    });

    // Establish SSE connection to receive messages from server
    this.connectSSE();

    console.error('Ethersync proxy started, connecting to http://localhost:2009');
  }

  connectSSE() {
    this.sseConnection = new EventSource('http://localhost:2009/events');
    
    this.sseConnection.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.sendToStdout(message);
        console.error('Received from server:', JSON.stringify(message, null, 2));
      } catch (e) {
        console.error('Failed to parse SSE message:', e);
      }
    };

    this.sseConnection.onerror = (error) => {
      console.error('SSE connection error:', error);
      // Retry connection automatically handled by EventSource
    };

    this.sseConnection.onopen = () => {
      console.error('SSE connection established');
    };
  }

  processBuffer() {
    while (true) {
      if (this.expectedLength === null) {
        // Look for Content-Length header
        const headerMatch = this.buffer.match(/Content-Length: (\d+)\r?\n\r?\n/);
        if (!headerMatch) {
          break; // Wait for more data
        }
        
        this.expectedLength = parseInt(headerMatch[1]);
        const headerLength = headerMatch[0].length;
        this.buffer = this.buffer.slice(headerMatch.index + headerLength);
      }

      if (this.buffer.length >= this.expectedLength) {
        // We have a complete message
        const messageStr = this.buffer.slice(0, this.expectedLength);
        this.buffer = this.buffer.slice(this.expectedLength);
        this.expectedLength = null;

        try {
          const message = JSON.parse(messageStr);
          this.forwardToServer(message);
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      } else {
        break; // Wait for more data
      }
    }
  }

  forwardToServer(message) {
    console.error('Forwarding to server:', JSON.stringify(message, null, 2));
    
    const postData = JSON.stringify(message);
    
    const options = {
      hostname: 'localhost',
      port: 2009,
      path: '/rpc',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      
      res.on('data', (chunk) => {
        body += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error('Server returned error:', res.statusCode, body);
        }
      });
    });

    req.on('error', (error) => {
      console.error('Failed to forward message to server:', error);
    });

    req.write(postData);
    req.end();
  }

  sendToStdout(message) {
    const messageStr = JSON.stringify(message);
    const contentLength = Buffer.byteLength(messageStr, 'utf8');
    
    process.stdout.write(`Content-Length: ${contentLength}\r\n\r\n`);
    process.stdout.write(messageStr);
  }
}

// Main execution
const proxy = new EthersyncProxy();
proxy.start();