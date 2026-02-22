import { describe, it, expect, vi } from 'vitest';
import { AaveProtocol } from './aave.js';
import { CompoundProtocol } from './compound.js';
import { MorphoProtocol } from './morpho.js';
import { MoonwellProtocol } from './moonwell.js';
import type { ReadContractClient } from './index.js';
import type { Address, Hex } from 'viem';
import { ADDRESSES, SECONDS_PER_YEAR } from '../config.js';
import { decodeFunctionData, parseAbi } from 'viem';

const VAULT: Address = '0x1111111111111111111111111111111111111111';

function createMockClient(responses: Record<string, unknown> = {}): ReadContractClient {
  return {
    readContract: vi.fn().mockImplementation(({ functionName, args }) => {
      const key = args
        ? `${functionName}:${JSON.stringify(args, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`
        : functionName;
      if (key in responses) return Promise.resolve(responses[key]);
      if (functionName in responses) return Promise.resolve(responses[functionName]);
      return Promise.reject(new Error(`Unmocked call: ${key}`));
    }),
  };
}

// ============ AaveProtocol ============

describe('AaveProtocol', () => {
  describe('getAPY', () => {
    it('converts currentLiquidityRate (RAY) to APY', async () => {
      // 5% APY → ratePerSecond = 0.05 / SECONDS_PER_YEAR
      // liquidityRate in RAY = ratePerSecond * 1e27
      const ratePerSecond = 0.05 / SECONDS_PER_YEAR;
      const liquidityRate = BigInt(Math.round(ratePerSecond * 1e27));

      const client = createMockClient({
        getReserveData: { currentLiquidityRate: liquidityRate },
      });
      const aave = new AaveProtocol(client);
      const apy = await aave.getAPY();

      expect(apy).toBeCloseTo(0.05, 4);
    });
  });

  describe('getBalance', () => {
    it('reads aToken balance', async () => {
      const client = createMockClient({
        balanceOf: 5_000_000n, // $5
      });
      const aave = new AaveProtocol(client);
      const balance = await aave.getBalance(VAULT);
      expect(balance).toBe(5_000_000n);
    });
  });

  describe('encodeDeposit / encodeWithdraw', () => {
    const client = createMockClient();
    const aave = new AaveProtocol(client);

    it('encodes supply calldata with correct selector', () => {
      const data = aave.encodeDeposit(1_000_000n, VAULT);
      expect(data).toMatch(/^0x/);
      // supply(address,uint256,address,uint16) selector = 0x617ba037
      expect(data.slice(0, 10)).toBe('0x617ba037');
    });

    it('encodes withdraw calldata with correct selector', () => {
      const data = aave.encodeWithdraw(500_000n, VAULT);
      expect(data).toMatch(/^0x/);
      // withdraw(address,uint256,address) selector = 0x69328dec
      expect(data.slice(0, 10)).toBe('0x69328dec');
    });
  });

  it('has correct metadata', () => {
    const aave = new AaveProtocol(createMockClient());
    expect(aave.id).toBe('aave');
    expect(aave.name).toBe('Aave V3');
    expect(aave.address).toBe(ADDRESSES.AAVE_POOL);
  });
});

// ============ CompoundProtocol ============

describe('CompoundProtocol', () => {
  describe('getAPY', () => {
    it('converts supply rate per second (1e18) to APY', async () => {
      const ratePerSecond = 0.04 / SECONDS_PER_YEAR;
      const supplyRate = BigInt(Math.round(ratePerSecond * 1e18));

      const client = createMockClient({
        getUtilization: 500000000000000000n, // 50%
        getSupplyRate: supplyRate,
      });
      const compound = new CompoundProtocol(client);
      const apy = await compound.getAPY();

      expect(apy).toBeCloseTo(0.04, 4);
    });
  });

  describe('getBalance', () => {
    it('reads comet balance', async () => {
      const client = createMockClient({ balanceOf: 10_000_000n });
      const compound = new CompoundProtocol(client);
      expect(await compound.getBalance(VAULT)).toBe(10_000_000n);
    });
  });

  describe('encodeDeposit / encodeWithdraw', () => {
    const compound = new CompoundProtocol(createMockClient());

    it('encodes supply calldata', () => {
      const data = compound.encodeDeposit(1_000_000n, VAULT);
      expect(data).toMatch(/^0x/);
      expect(data.length).toBeGreaterThan(10);
    });

    it('encodes withdraw calldata', () => {
      const data = compound.encodeWithdraw(500_000n, VAULT);
      expect(data).toMatch(/^0x/);
    });
  });

  it('has correct metadata', () => {
    const compound = new CompoundProtocol(createMockClient());
    expect(compound.id).toBe('compound');
    expect(compound.name).toBe('Compound V3');
    expect(compound.address).toBe(ADDRESSES.COMPOUND_CUSDC);
  });
});

// ============ MorphoProtocol ============

describe('MorphoProtocol', () => {
  describe('getAPY', () => {
    it('returns 0 when totalSupply is 0', async () => {
      const client = createMockClient({
        totalAssets: 0n,
        totalSupply: 0n,
      });
      const morpho = new MorphoProtocol(client);
      expect(await morpho.getAPY()).toBe(0);
    });

    it('returns estimate when insufficient history', async () => {
      const client = createMockClient({
        totalAssets: 1_050_000n,
        totalSupply: 1_000_000n,
      });
      const morpho = new MorphoProtocol(client);
      const apy = await morpho.getAPY();
      // First call returns 5% estimate
      expect(apy).toBe(0.05);
    });
  });

  describe('getBalance', () => {
    it('converts shares to assets', async () => {
      const client = createMockClient({
        balanceOf: 100n,
        convertToAssets: 105n,
      });
      const morpho = new MorphoProtocol(client);
      expect(await morpho.getBalance(VAULT)).toBe(105n);
    });

    it('returns 0 when share balance is 0', async () => {
      const client = createMockClient({ balanceOf: 0n });
      const morpho = new MorphoProtocol(client);
      expect(await morpho.getBalance(VAULT)).toBe(0n);
    });
  });

  describe('encodeDeposit / encodeWithdraw', () => {
    const morpho = new MorphoProtocol(createMockClient());

    it('encodes ERC-4626 deposit', () => {
      const data = morpho.encodeDeposit(1_000_000n, VAULT);
      expect(data).toMatch(/^0x/);
      // deposit(uint256,address) selector = 0x6e553f65
      expect(data.slice(0, 10)).toBe('0x6e553f65');
    });

    it('encodes ERC-4626 withdraw with vault as owner and receiver', () => {
      const data = morpho.encodeWithdraw(500_000n, VAULT);
      expect(data).toMatch(/^0x/);
      // withdraw(uint256,address,address) selector = 0xb460af94
      expect(data.slice(0, 10)).toBe('0xb460af94');
    });
  });

  it('has correct metadata', () => {
    const morpho = new MorphoProtocol(createMockClient());
    expect(morpho.id).toBe('morpho');
    expect(morpho.address).toBe(ADDRESSES.MORPHO_SPARK_VAULT);
  });
});

// ============ MoonwellProtocol ============

describe('MoonwellProtocol', () => {
  describe('getAPY', () => {
    it('converts supplyRatePerTimestamp (1e18) to APY', async () => {
      const ratePerSecond = 0.06 / SECONDS_PER_YEAR;
      const supplyRate = BigInt(Math.round(ratePerSecond * 1e18));

      const client = createMockClient({ supplyRatePerTimestamp: supplyRate });
      const moonwell = new MoonwellProtocol(client);
      const apy = await moonwell.getAPY();

      expect(apy).toBeCloseTo(0.06, 4);
    });
  });

  describe('getBalance', () => {
    it('converts mToken balance using exchange rate', async () => {
      // mToken balance = 100, exchange rate = 2e20 (2x, scaled by 1e20)
      const exchangeRate = 2n * 10n ** 20n;
      const client = createMockClient({
        balanceOf: 100n,
        exchangeRateStored: exchangeRate,
      });
      const moonwell = new MoonwellProtocol(client);
      const balance = await moonwell.getBalance(VAULT);
      // underlying = 100 * 2e20 / 1e20 = 200
      expect(balance).toBe(200n);
    });

    it('returns 0 when mToken balance is 0', async () => {
      const client = createMockClient({ balanceOf: 0n });
      const moonwell = new MoonwellProtocol(client);
      expect(await moonwell.getBalance(VAULT)).toBe(0n);
    });
  });

  describe('encodeDeposit / encodeWithdraw', () => {
    const moonwell = new MoonwellProtocol(createMockClient());

    it('encodes mint calldata', () => {
      const data = moonwell.encodeDeposit(1_000_000n, VAULT);
      expect(data).toMatch(/^0x/);
      // mint(uint256) selector = 0xa0712d68
      expect(data.slice(0, 10)).toBe('0xa0712d68');
    });

    it('encodes redeemUnderlying calldata', () => {
      const data = moonwell.encodeWithdraw(500_000n, VAULT);
      expect(data).toMatch(/^0x/);
      // redeemUnderlying(uint256) selector = 0x852a12e3
      expect(data.slice(0, 10)).toBe('0x852a12e3');
    });
  });

  it('has correct metadata', () => {
    const moonwell = new MoonwellProtocol(createMockClient());
    expect(moonwell.id).toBe('moonwell');
    expect(moonwell.address).toBe(ADDRESSES.MOONWELL_MUSDC);
  });
});
