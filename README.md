Big Thanks to ArQmA team for support.

# Evolution Electron Wallet


  * Repo to latest version of evolution-electron-wallet
  
  
  

#### Pre-requisites

- Download latest daemon [evolutiond](https://github.com/evolution-project/evolution/releases/latest)

#### Commands
```
nvm use 11.9.0
npm install -g quasar-cli
git clone https://github.com/evolution-project/evolution-electron-wallet
cd evolution-electron-wallet
cp path_to_evolution_binaries/evolutiond bin/
cp path_to_evolution_binaries/evolution-wallet-rpc bin/
npm install
```

For dev:
```
npm run dev
```

For building:

**Note:** This will only build the binaries for the system you run the command on. Running this command on `linux` will only make `linux` binaries, no `mac` or `windows` binaries.
```
npm run build
```

### Credits

ArqTras https://github.com/arqma/arqma-electron-wallet

mosu-forge https://github.com/ryo-currency/ryo-wallet

Mikunj https://github.com/loki-project/loki-electron-gui-wallet
