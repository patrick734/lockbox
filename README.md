# Lockbox — token & liquidity locker on BOT Chain

Projects lock their tokens or LP tokens until a date so holders can see they can't be pulled.
Anyone can paste a token address into the site and see what share of its supply is locked,
in which locks, and when each one opens. Results are shareable as `?token=0x…` links.

- **All at once** — everything opens on the unlock date.
- **Gradually** — tokens open evenly from the lock date until the unlock date.
- The lock owner can push the unlock date **later** (never earlier) and hand the lock to another wallet.
- A flat fee in BOT per lock (0.1 BOT at launch, hard-capped at 1 BOT) goes to the treasury.

## What the contract owner can and can't do
The owner can only set the lock fee, set the treasury, and pause **new** locks.
There is no function that moves, shortens or unlocks anyone's tokens — a test checks
the full list of state-changing functions so one can't be added by accident.

## Security properties (covered by tests)
- Records the amount actually received, so fee-on-transfer tokens can't over-credit a lock
- Linear locks: extending never reduces what has already unlocked
- ReentrancyGuard on lock/withdraw; SafeERC20 for every transfer; two-step ownership
- Pause never blocks withdraw, extend or transfer
- Solvency: the contract's token balance always equals locked minus withdrawn
- Not supported: rebasing tokens (balances that change on their own)

## Run
```bash
npm install
npx hardhat test               # if the solc CDN is blocked: USE_SOLCJS=1 npx hardhat test
cp .env.example .env           # PRIVATE_KEY, BOT_RPC_URL, OWNER_ADDRESS, TREASURY_ADDRESS
npx hardhat run scripts/deploy.js --network botMainnet
```
Then put the printed address in `docs/index.html` → `CONFIG.contract` and deploy `docs/` to Vercel
(Framework Preset: Other).

BOT Chain mainnet: chain ID 677, gas token BOT, explorer https://scan.botchain.ai.
