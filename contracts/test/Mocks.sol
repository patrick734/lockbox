// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockToken is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) { _dec = d; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

/// Takes a 1% burn on every transfer.
contract FeeToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
    function _update(address from, address to, uint256 v) internal override {
        if (from != address(0) && to != address(0)) {
            super._update(from, address(0), v / 100);
            super._update(from, to, v - v / 100);
        } else {
            super._update(from, to, v);
        }
    }
}

/// Treasury that refuses BOT.
contract Rejecter { receive() external payable { revert("no"); } }
