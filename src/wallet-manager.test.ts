import { describe, it, expect } from 'vitest';
import { ProtocolEncoders } from './wallet-manager.js';
import type { Address } from 'viem';
import { ADDRESSES } from './config.js';

const VAULT: Address = '0x1111111111111111111111111111111111111111';

describe('ProtocolEncoders', () => {
  describe('aaveSupply', () => {
    it('encodes supply(address,uint256,address,uint16) with referralCode=0', () => {
      const data = ProtocolEncoders.aaveSupply(ADDRESSES.USDC as Address, 1_000_000n, VAULT);
      // supply selector = 0x617ba037
      expect(data.slice(0, 10)).toBe('0x617ba037');
      // Should contain the USDC address (without 0x prefix, lowercase, zero-padded)
      expect(data.toLowerCase()).toContain(ADDRESSES.USDC.slice(2).toLowerCase());
    });
  });

  describe('aaveWithdraw', () => {
    it('encodes withdraw(address,uint256,address)', () => {
      const data = ProtocolEncoders.aaveWithdraw(ADDRESSES.USDC as Address, 500_000n, VAULT);
      expect(data.slice(0, 10)).toBe('0x69328dec');
    });
  });

  describe('compoundSupply', () => {
    it('encodes supply(address,uint256)', () => {
      const data = ProtocolEncoders.compoundSupply(ADDRESSES.USDC as Address, 1_000_000n);
      expect(data).toMatch(/^0x/);
      expect(data.length).toBeGreaterThan(10);
    });
  });

  describe('compoundWithdraw', () => {
    it('encodes withdraw(address,uint256)', () => {
      const data = ProtocolEncoders.compoundWithdraw(ADDRESSES.USDC as Address, 500_000n);
      expect(data).toMatch(/^0x/);
    });
  });

  describe('erc4626Deposit', () => {
    it('encodes deposit(uint256,address)', () => {
      const data = ProtocolEncoders.erc4626Deposit(1_000_000n, VAULT);
      expect(data.slice(0, 10)).toBe('0x6e553f65');
    });
  });

  describe('erc4626Withdraw', () => {
    it('encodes withdraw(uint256,address,address)', () => {
      const data = ProtocolEncoders.erc4626Withdraw(500_000n, VAULT, VAULT);
      expect(data.slice(0, 10)).toBe('0xb460af94');
    });
  });

  describe('moonwellMint', () => {
    it('encodes mint(uint256)', () => {
      const data = ProtocolEncoders.moonwellMint(1_000_000n);
      expect(data.slice(0, 10)).toBe('0xa0712d68');
    });
  });

  describe('moonwellRedeem', () => {
    it('encodes redeemUnderlying(uint256)', () => {
      const data = ProtocolEncoders.moonwellRedeem(500_000n);
      expect(data.slice(0, 10)).toBe('0x852a12e3');
    });
  });
});
