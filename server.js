
var braid_fetch = require('braid-http').fetch

eval(require('fs').readFileSync(`${__dirname}/node_modules/braid-text/simpleton-client.js`, 'utf8'))

var url = 'https://dt.braid.org/zz'

// Main execution
const server = new EthersyncServer();
server.start();

function EthersyncServer() {
  this.openFiles = new Map(); // uri -> file state
  this.nextId = 1;
  this.sseClients = new Set(); // Store SSE connections

  Object.assign(this, {
    start() {
      const server = require('http').createServer((req, res) => {
        // Enable CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        if (req.url === '/rpc' && req.method === 'POST') {
          this.handleRPC(req, res);
        } else if (req.url === '/events' && req.method === 'GET') {
          this.handleSSE(req, res);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      server.listen(1009, () => {
        console.error('Ethersync server listening on http://localhost:1009');
      });
    },

    handleSSE(req, res) {
      // Set up SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no' // Disable Nginx buffering
      });

      // Send initial ping to establish connection
      res.write(':ping\n\n');

      // Add client to set
      this.sseClients.add(res);
      console.error('SSE client connected. Total clients:', this.sseClients.size);

      // Set up ping to keep connection alive
      const pingInterval = setInterval(() => {
        res.write(':ping\n\n');
      }, 30000);

      // Clean up on disconnect
      req.on('close', () => {
        this.sseClients.delete(res);
        clearInterval(pingInterval);
        console.error('SSE client disconnected. Total clients:', this.sseClients.size);
      });
    },

    handleRPC(req, res) {
      let body = '';
      
      req.on('data', (chunk) => {
        body += chunk;
      });
      
      req.on('end', () => {
        try {
          const message = JSON.parse(body);
          console.error('Received RPC:', JSON.stringify(message, null, 2));
          
          // Process the message
          if (message.method === 'open') {
            this.handleOpen(message);
          } else if (message.method === 'close') {
            this.handleClose(message);
          } else if (message.method === 'edit') {
            this.handleEdit(message);
          } else if (message.method === 'cursor') {
            console.error('Cursor update received');
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } catch (e) {
          console.error('Failed to process RPC:', e);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    },

    handleOpen(message) {
      var { uri, content } = message.params;

      content = ''
      
      // Initialize file state
      const fileState = {
        content: content,
        editorRevision: 0,
        braidClient: null
      };

      this.openFiles.set(uri, fileState);

      // Create simpleton client connection to braid.org
      const braidClient = simpleton_client(url, {
        get_state: () => {
          return this.openFiles.get(uri)?.content || '';
        },
        
        on_patches: (patches) => {
          console.error('Received patches from braid:', patches);
          const currentState = this.openFiles.get(uri);
          if (!currentState) return;

          // Convert patches to line/char format and broadcast to SSE clients
          const convertedDeltas = patches.map(patch => {
            const startLineChar = offsetToLineChar(currentState.content, patch.range[0]);
            const endLineChar = offsetToLineChar(currentState.content, patch.range[1]);
            
            return {
              range: {
                start: startLineChar,
                end: endLineChar
              },
              replacement: patch.content
            };
          });

          // Apply patches to our content
          let newContent = currentState.content;
          let offset = 0;
          
          for (const patch of patches) {
            const startPos = patch.range[0] + offset;
            const endPos = patch.range[1] + offset;
            newContent = newContent.substring(0, startPos) + 
                        patch.content + 
                        newContent.substring(endPos);
            offset += patch.content.length - (patch.range[1] - patch.range[0]);
          }
          
          // Update our state
          currentState.content = newContent;

          // Send edit notification via SSE
          const edit = {
            jsonrpc: '2.0',
            method: 'edit',
            params: {
              uri: uri,
              revision: currentState.editorRevision,
              delta: convertedDeltas
            }
          };

          this.broadcastMessage(edit);
          console.error(`Broadcasted edit from braid to ${uri}`);
        },
        
        on_error: (error) => {
          console.error('Braid client error:', error);
        }
      });

      fileState.braidClient = braidClient;

      // Send success response
      this.broadcastMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: { success: true }
      });

      // clear away initial contents for now..
      var initial_content = require('fs').readFileSync(uri.slice('file://'.length), 'utf8')
      console.log(`removing initial content of: ${initial_content}`)
      this.broadcastMessage({
        jsonrpc: '2.0',
        method: 'edit',
        params: {
          uri: uri,
          revision: fileState.editorRevision,
          delta: [{
            range: {
              start: offsetToLineChar(initial_content, 0),
              end: offsetToLineChar(initial_content, initial_content.length)
            },
            replacement: ''
          }]
        }
      });

      console.error(`Opened file: ${uri}, connected to braid`);
    },

    handleClose(message) {
      const { uri } = message.params;
      
      const fileState = this.openFiles.get(uri);
      if (fileState) {
        // Stop braid client
        if (fileState.braidClient && fileState.braidClient.stop) {
          fileState.braidClient.stop();
        }
        this.openFiles.delete(uri);
      }

      // Send success response
      this.broadcastMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: { success: true }
      });
      
      console.error(`Closed file: ${uri}`);
    },

    handleEdit(message) {
      const { uri, revision, delta } = message.params;
      
      const fileState = this.openFiles.get(uri);
      if (!fileState) {
        console.error(`Edit received for unknown file: ${uri}`);
        return;
      }

      console.error(`Editor edit received for ${uri}, revision ${revision}`);

      // Apply edits to our local content and forward to braid
      let newContent = fileState.content;
      
      // Sort deltas by position (descending) to apply them without position conflicts
      const sortedDeltas = [...delta].sort((a, b) => {
        const aStart = lineCharToOffset(newContent, a.range.start.line, a.range.start.character);
        const bStart = lineCharToOffset(newContent, b.range.start.line, b.range.start.character);
        return bStart - aStart; // descending order
      });

      // Apply each delta to our content
      for (const deltaItem of sortedDeltas) {
        const startOffset = lineCharToOffset(newContent, deltaItem.range.start.line, deltaItem.range.start.character);
        const endOffset = lineCharToOffset(newContent, deltaItem.range.end.line, deltaItem.range.end.character);
        
        newContent = newContent.substring(0, startOffset) + 
                    deltaItem.replacement + 
                    newContent.substring(endOffset);
      }

      // Update our state
      fileState.content = newContent;
      fileState.editorRevision++;

      // Notify braid client of the change
      if (fileState.braidClient && fileState.braidClient.changed) {
        fileState.braidClient.changed().catch(error => {
          console.error('Error sending change to braid:', error);
        });
      }

      // Send success response
      this.broadcastMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: { success: true }
      });
    },

    broadcastMessage(message) {
      const data = `data: ${JSON.stringify(message)}\n\n`;
      
      // Send to all connected SSE clients
      for (const client of this.sseClients) {
        try {
          client.write(data);
        } catch (e) {
          console.error('Failed to send to SSE client:', e);
          // Client will be removed when 'close' event fires
        }
      }
      
      console.error('Broadcasted to', this.sseClients.size, 'clients, the message: ' + JSON.stringify(message, null, 4));
    }
  })
}

// Utility functions

// Convert line/character position to global offset
function lineCharToOffset(content, line, character) {
  const lines = content.split('\n');
  let offset = 0;
  
  // Add lengths of all previous lines (including newline characters)
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for newline
  }
  
  // Add character offset within the target line
  if (line < lines.length) {
    offset += Math.min(character, lines[line].length);
  }
  
  return offset;
}

// Convert global offset to line/character position
function offsetToLineChar(content, offset) {
  const lines = content.split('\n');
  let currentOffset = 0;
  
  for (let line = 0; line < lines.length; line++) {
    const lineLength = lines[line].length;
    const lineEndOffset = currentOffset + lineLength;
    
    if (offset <= lineEndOffset) {
      return {
        line: line,
        character: offset - currentOffset
      };
    }
    
    currentOffset = lineEndOffset + 1; // +1 for newline
  }
  
  // If offset is beyond content, return end position
  return {
    line: lines.length - 1,
    character: lines[lines.length - 1].length
  };
}
