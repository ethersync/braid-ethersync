# braid-ethersync

### Setup

**Prerequisites:** Install the Ethersync plugin in VS Code

### Run the demo

1. **Clone and navigate**
   ```bash
   git clone https://github.com/braid-org/braid-ethersync.git
   cd braid-ethersync
   ```

2. **Link the client** (tricks Ethersync into using our client)
   ```bash
   chmod +x ./client.js
   sudo ln -sf ./client.js /usr/local/bin/ethersync
   ```

3. **Start server**
   ```bash
   node server.js
   ```

4. **Reload VS Code plugin**

5. **Open shared file**
   ```bash
   code shared/zz
   ```

6. **Verify sync** with https://dt.braid.org/zz