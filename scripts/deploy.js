// Usage: npx hardhat run scripts/deploy.js --network botMainnet
const hre = require("hardhat");
const readline = require("readline");

async function confirm(q) {
  if (process.env.CONFIRM === "yes") return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question(q, r));
  rl.close();
  return a.trim().toLowerCase() === "yes";
}

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No PRIVATE_KEY set in .env");

  const owner = process.env.OWNER_ADDRESS;       // use a Safe multisig on mainnet
  const treasury = process.env.TREASURY_ADDRESS; // where platform fees accrue
  if (!ethers.isAddress(owner) || !ethers.isAddress(treasury)) {
    throw new Error("Set OWNER_ADDRESS and TREASURY_ADDRESS in .env");
  }

  const { chainId } = await ethers.provider.getNetwork();
  const bal = await ethers.provider.getBalance(deployer.address);

  console.log(`Network:   ${network.name} (chainId ${chainId})`);
  console.log(`Deployer:  ${deployer.address}  balance ${ethers.formatEther(bal)} BOT`);
  console.log(`Owner:     ${owner}`);
  console.log(`Treasury:  ${treasury}`);

  if (network.name === "botMainnet" && chainId !== 677n) {
    throw new Error(`RPC returned chainId ${chainId}, expected 677. Wrong RPC URL?`);
  }
  if (bal === 0n) throw new Error("Deployer has no BOT for gas");
  if (owner.toLowerCase() === deployer.address.toLowerCase()) {
    console.warn("⚠️  Owner is the deployer EOA. A multisig is strongly recommended for mainnet.");
  }

  if (!(await confirm("Type 'yes' to deploy: "))) {
    console.log("Aborted.");
    return;
  }

  const Factory = await ethers.getContractFactory("Lockbox");
  const ab = await Factory.deploy(owner, treasury);
  console.log(`Tx:        ${ab.deploymentTransaction().hash}`);
  await ab.waitForDeployment();
  const addr = await ab.getAddress();
  console.log(`✅ Lockbox deployed at ${addr}`);
  console.log(`   Explorer: https://scan.botchain.ai/address/${addr}`);

  // sanity read-back
  console.log(`   owner()=${await ab.owner()} treasury()=${await ab.treasury()} lockFee=${ethers.formatEther(await ab.lockFee())} BOT`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
