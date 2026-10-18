const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const DAY = 24 * 3600;
const FEE = E(0.1);

async function deploy() {
  const [owner, treasury, alice, bob, carol] = await ethers.getSigners();
  const lb = await (await ethers.getContractFactory("Lockbox")).deploy(owner.address, treasury.address);
  const tok = await (await ethers.getContractFactory("MockToken")).deploy("Test", "TST", 18);
  const feeTok = await (await ethers.getContractFactory("FeeToken")).deploy();
  for (const a of [alice, bob]) {
    await tok.mint(a.address, E(1_000_000));
    await feeTok.mint(a.address, E(1_000));
    await tok.connect(a).approve(lb.target, ethers.MaxUint256);
    await feeTok.connect(a).approve(lb.target, ethers.MaxUint256);
  }
  return { lb, tok, feeTok, owner, treasury, alice, bob, carol };
}
const now = async () => BigInt(await time.latest());

async function cliffLock() {
  const f = await deploy();
  const unlock = (await now()) + BigInt(30 * DAY);
  await f.lb.connect(f.alice).lock(f.tok.target, E(1000), unlock, false, "Team tokens", { value: FEE });
  return { ...f, id: 1n, unlock };
}
async function linearLock() {
  const f = await deploy();
  const unlock = (await now()) + BigInt(100 * DAY) + 1n; // +1 because the lock tx mines one second later
  await f.lb.connect(f.alice).lock(f.tok.target, E(1000), unlock, true, "Vesting", { value: FEE });
  return { ...f, id: 1n, unlock };
}

describe("Lockbox", () => {
  describe("lock", () => {
    it("takes tokens and the fee, indexes by token and owner", async () => {
      const { lb, tok, alice, id } = await loadFixture(cliffLock);
      expect(await tok.balanceOf(lb.target)).to.equal(E(1000));
      expect(await lb.feesAccrued()).to.equal(FEE);
      const l = await lb.getLock(id);
      expect(l.owner).to.equal(alice.address);
      expect(l.amount).to.equal(E(1000));
      expect(l.label).to.equal("Team tokens");
      expect(await lb.locksOfToken(tok.target)).to.deep.equal([1n]);
      expect(await lb.locksOfOwner(alice.address)).to.deep.equal([1n]);
      expect(await lb.stillLocked(id)).to.equal(E(1000));
    });

    it("requires the exact fee", async () => {
      const { lb, tok, alice } = await loadFixture(deploy);
      const u = (await now()) + 1000n;
      await expect(lb.connect(alice).lock(tok.target, 1, u, false, "", { value: 0 })).to.be.revertedWithCustomError(lb, "WrongFee");
      await expect(lb.connect(alice).lock(tok.target, 1, u, false, "", { value: E(1) })).to.be.revertedWithCustomError(lb, "WrongFee");
    });

    it("rejects bad params", async () => {
      const { lb, tok, alice } = await loadFixture(deploy);
      const t = await now();
      const opts = { value: FEE };
      await expect(lb.connect(alice).lock(ethers.ZeroAddress, 1, t + 100n, false, "", opts)).to.be.revertedWithCustomError(lb, "InvalidParams");
      await expect(lb.connect(alice).lock(tok.target, 0, t + 100n, false, "", opts)).to.be.revertedWithCustomError(lb, "InvalidParams");
      await expect(lb.connect(alice).lock(tok.target, 1, t, false, "", opts)).to.be.revertedWithCustomError(lb, "InvalidParams");
      await expect(lb.connect(alice).lock(tok.target, 1, t + BigInt(3651 * DAY), false, "", opts)).to.be.revertedWithCustomError(lb, "InvalidParams");
      await expect(lb.connect(alice).lock(tok.target, 1, t + 100n, false, "x".repeat(121), opts)).to.be.revertedWithCustomError(lb, "InvalidParams");
    });

    it("records what actually arrived for fee-on-transfer tokens", async () => {
      const { lb, feeTok, alice } = await loadFixture(deploy);
      await lb.connect(alice).lock(feeTok.target, E(100), (await now()) + 1000n, false, "", { value: FEE });
      expect((await lb.getLock(1)).amount).to.equal(E(99));
      expect(await feeTok.balanceOf(lb.target)).to.equal(E(99));
    });
  });

  describe("cliff", () => {
    it("nothing before unlock, everything at unlock", async () => {
      const { lb, tok, alice, id, unlock } = await loadFixture(cliffLock);
      await expect(lb.connect(alice).withdraw(id)).to.be.revertedWithCustomError(lb, "NothingUnlocked");
      await time.increaseTo(unlock - 2n);
      expect(await lb.withdrawable(id)).to.equal(0);
      await time.increaseTo(unlock);
      await expect(lb.connect(alice).withdraw(id)).to.changeTokenBalance(tok, alice, E(1000));
      await expect(lb.connect(alice).withdraw(id)).to.be.revertedWithCustomError(lb, "NothingUnlocked");
    });

    it("only the lock owner can withdraw", async () => {
      const { lb, bob, owner, id, unlock } = await loadFixture(cliffLock);
      await time.increaseTo(unlock);
      await expect(lb.connect(bob).withdraw(id)).to.be.revertedWithCustomError(lb, "NotLockOwner");
      await expect(lb.connect(owner).withdraw(id)).to.be.revertedWithCustomError(lb, "NotLockOwner");
    });
  });

  describe("linear", () => {
    it("releases evenly over time", async () => {
      const { lb, tok, alice, id } = await loadFixture(linearLock);
      const l = await lb.getLock(id);
      await time.increaseTo(l.start + 25n * BigInt(DAY));
      const w = await lb.withdrawable(id);
      expect(w).to.be.closeTo(E(250), E(0.01));
      await lb.connect(alice).withdraw(id);
      await time.increaseTo(l.start + 50n * BigInt(DAY));
      expect(await lb.withdrawable(id)).to.be.closeTo(E(250), E(0.01));
      await time.increaseTo(l.unlock);
      await lb.connect(alice).withdraw(id);
      expect(await tok.balanceOf(lb.target)).to.equal(0);
      expect((await lb.getLock(id)).withdrawn).to.equal(E(1000));
    });

    it("extend keeps what already vested and spreads the rest", async () => {
      const { lb, alice, id } = await loadFixture(linearLock);
      const l = await lb.getLock(id);
      await time.increaseTo(l.start + 50n * BigInt(DAY));
      const vestedBefore = await lb.withdrawable(id);
      const newUnlock = (await now()) + BigInt(200 * DAY);
      await lb.connect(alice).extend(id, newUnlock);
      // vested amount must not shrink
      expect(await lb.withdrawable(id)).to.be.gte(vestedBefore);
      expect(await lb.withdrawable(id)).to.be.closeTo(E(500), E(0.1));
      // halfway through the new window, half of the remaining 500 is added
      await time.increase(100 * DAY);
      expect(await lb.withdrawable(id)).to.be.closeTo(E(750), E(0.1));
      await time.increaseTo(newUnlock);
      expect(await lb.withdrawable(id)).to.equal(E(1000));
    });
  });

  describe("extend & transfer", () => {
    it("unlock can only move later", async () => {
      const { lb, alice, bob, id, unlock } = await loadFixture(cliffLock);
      await expect(lb.connect(alice).extend(id, unlock)).to.be.revertedWithCustomError(lb, "InvalidParams");
      await expect(lb.connect(alice).extend(id, unlock - 1n)).to.be.revertedWithCustomError(lb, "InvalidParams");
      await expect(lb.connect(bob).extend(id, unlock + 1n)).to.be.revertedWithCustomError(lb, "NotLockOwner");
      await lb.connect(alice).extend(id, unlock + BigInt(DAY));
      await time.increaseTo(unlock);
      expect(await lb.withdrawable(id)).to.equal(0);
    });

    it("transfer moves withdrawal rights", async () => {
      const { lb, tok, alice, bob, id, unlock } = await loadFixture(cliffLock);
      await expect(lb.connect(bob).transferLock(id, bob.address)).to.be.revertedWithCustomError(lb, "NotLockOwner");
      await expect(lb.connect(alice).transferLock(id, ethers.ZeroAddress)).to.be.revertedWithCustomError(lb, "InvalidParams");
      await lb.connect(alice).transferLock(id, bob.address);
      expect(await lb.locksOfOwner(bob.address)).to.deep.equal([1n]);
      await time.increaseTo(unlock);
      await expect(lb.connect(alice).withdraw(id)).to.be.revertedWithCustomError(lb, "NotLockOwner");
      await expect(lb.connect(bob).withdraw(id)).to.changeTokenBalance(tok, bob, E(1000));
    });
  });

  describe("fees & admin", () => {
    it("anyone can push fees to the treasury", async () => {
      const { lb, treasury, bob } = await loadFixture(cliffLock);
      await expect(lb.connect(bob).collectFees()).to.changeEtherBalance(treasury, FEE);
      expect(await lb.feesAccrued()).to.equal(0);
      await expect(lb.collectFees()).to.be.revertedWithCustomError(lb, "NothingUnlocked");
    });

    it("fee capped at 1 BOT, owner only", async () => {
      const { lb, owner, alice, treasury } = await loadFixture(deploy);
      await expect(lb.connect(alice).setConfig(0, treasury.address)).to.be.revertedWithCustomError(lb, "OwnableUnauthorizedAccount");
      await expect(lb.connect(owner).setConfig(E(1.01), treasury.address)).to.be.revertedWithCustomError(lb, "InvalidParams");
      await lb.connect(owner).setConfig(0, alice.address);
      expect(await lb.lockFee()).to.equal(0);
      expect(await lb.treasury()).to.equal(alice.address);
    });

    it("pause blocks new locks only", async () => {
      const { lb, tok, owner, alice, id, unlock } = await loadFixture(cliffLock);
      await lb.connect(owner).pause();
      await expect(lb.connect(alice).lock(tok.target, 1, unlock, false, "", { value: FEE })).to.be.revertedWithCustomError(lb, "EnforcedPause");
      await lb.connect(alice).extend(id, unlock + 10n);
      await time.increaseTo(unlock + 10n);
      await expect(lb.connect(alice).withdraw(id)).to.changeTokenBalance(tok, alice, E(1000));
    });

    it("a treasury that rejects BOT doesn't affect locks", async () => {
      const { lb, tok, owner, alice, id, unlock } = await loadFixture(cliffLock);
      const rej = await (await ethers.getContractFactory("Rejecter")).deploy();
      await lb.connect(owner).setConfig(FEE, rej.target);
      await expect(lb.collectFees()).to.be.revertedWithCustomError(lb, "TransferFailed");
      await time.increaseTo(unlock);
      await expect(lb.connect(alice).withdraw(id)).to.changeTokenBalance(tok, alice, E(1000));
    });

    it("owner has no way to move locked tokens", async () => {
      const { lb } = await loadFixture(deploy);
      const fns = lb.interface.fragments.filter(f => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure").map(f => f.name).sort();
      expect(fns).to.deep.equal(["acceptOwnership", "collectFees", "extend", "lock", "pause", "renounceOwnership", "setConfig", "transferLock", "transferOwnership", "unpause", "withdraw"]);
    });
  });

  describe("solvency", () => {
    it("token balance always equals total locked minus withdrawn", async () => {
      const { lb, tok, alice, bob } = await loadFixture(deploy);
      const t = await now();
      await lb.connect(alice).lock(tok.target, E(300), t + BigInt(10 * DAY), false, "a", { value: FEE });
      await lb.connect(bob).lock(tok.target, E(700), t + BigInt(40 * DAY), true, "b", { value: FEE });
      await lb.connect(alice).lock(tok.target, E(50), t + BigInt(90 * DAY), true, "c", { value: FEE });
      await time.increase(20 * DAY);
      await lb.connect(alice).withdraw(1);
      await lb.connect(bob).withdraw(2);
      await lb.connect(alice).withdraw(3);
      await lb.connect(bob).extend(2, t + BigInt(80 * DAY));
      await time.increase(15 * DAY);
      await lb.connect(bob).withdraw(2);
      let owed = 0n;
      for (const id of [1, 2, 3]) { const l = await lb.getLock(id); owed += l.amount - l.withdrawn; }
      expect(await tok.balanceOf(lb.target)).to.equal(owed);
      // and nobody can ever withdraw more than they locked
      await time.increase(400 * DAY);
      await lb.connect(bob).withdraw(2); await lb.connect(alice).withdraw(3);
      expect(await tok.balanceOf(lb.target)).to.equal(0);
    });
  });
});
