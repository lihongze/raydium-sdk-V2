import BN from "bn.js";

import { ApiLiquidityPoolInfo } from "../../api";
import { BN_ONE, BN_ZERO } from "../../common/bignumber";
import { createLogger } from "../../common/logger";
import { parseSimulateLogToJson, parseSimulateValue, simulateMultipleInstruction } from "../../common/txTool";
import { jsonInfo2PoolKeys } from "../../common/utility";
import { CurrencyAmount, Percent, Price, Token, TokenAmount } from "../../module";
import ModuleBase, { ModuleBaseProps } from "../moduleBase";

import { LIQUIDITY_FEES_DENOMINATOR, LIQUIDITY_FEES_NUMERATOR } from "./constant";
import {
  formatLayout,
  getDxByDyBaseIn,
  getDyByDxBaseIn,
  getStablePrice,
  MODEL_DATA_PUBKEY,
  StableModelLayout,
} from "./stable";
import {
  LiquidityComputeAmountOutParams,
  LiquidityComputeAmountOutReturn,
  LiquidityFetchMultipleInfoParams,
  LiquidityPoolInfo,
  SDKParsedLiquidityInfo,
} from "./type";
import { getAmountSide, includesToken, makeSimulatePoolInfoInstruction } from "./util";

let stableModelData: StableModelLayout = {
  accountType: 0,
  status: 0,
  multiplier: 0,
  validDataCount: 0,
  DataElement: [],
};

export default class Liquidity extends ModuleBase {
  private _poolInfos: ApiLiquidityPoolInfo[] = [];
  private _officialIds: Set<string> = new Set();
  private _unOfficialIds: Set<string> = new Set();
  private _sdkParseInfoCache: Map<string, SDKParsedLiquidityInfo[]> = new Map();
  constructor(params: ModuleBaseProps) {
    super(params);
  }

  public async init(): Promise<void> {
    this.checkDisabled();
    await this.scope.fetchLiquidity();
    if (!this.scope.apiData.liquidityPools) return;
    const { data } = this.scope.apiData.liquidityPools;
    const [official, unOfficial] = [data.official || [], data.unOfficial || []];
    this._poolInfos = [...official, ...unOfficial];
    this._officialIds = new Set(official.map((i) => i.id));
    this._unOfficialIds = new Set(unOfficial.map((i) => i.id));
  }

  get allPools(): ApiLiquidityPoolInfo[] {
    return this._poolInfos;
  }
  get allPoolIdSet(): { official: Set<string>; unOfficial: Set<string> } {
    return {
      official: this._officialIds,
      unOfficial: this._unOfficialIds,
    };
  }

  public async initStableModelLayout(): Promise<void> {
    if (stableModelData.validDataCount === 0) {
      if (this.scope.connection) {
        const acc = await this.scope.connection.getAccountInfo(MODEL_DATA_PUBKEY);
        if (acc) stableModelData = formatLayout(acc?.data);
      }
    }
  }

  public async fetchMultipleLiquidityInfo({ pools }: LiquidityFetchMultipleInfoParams): Promise<LiquidityPoolInfo[]> {
    await this.initStableModelLayout();

    const instructions = pools.map((pool) => makeSimulatePoolInfoInstruction(pool));
    const logs = await simulateMultipleInstruction(this.scope.connection, instructions, "GetPoolData");

    const poolsInfo = logs.map((log) => {
      const json = parseSimulateLogToJson(log, "GetPoolData");
      const status = new BN(parseSimulateValue(json, "status"));
      const baseDecimals = Number(parseSimulateValue(json, "coin_decimals"));
      const quoteDecimals = Number(parseSimulateValue(json, "pc_decimals"));
      const lpDecimals = Number(parseSimulateValue(json, "lp_decimals"));
      const baseReserve = new BN(parseSimulateValue(json, "pool_coin_amount"));
      const quoteReserve = new BN(parseSimulateValue(json, "pool_pc_amount"));
      const lpSupply = new BN(parseSimulateValue(json, "pool_lp_supply"));
      let startTime = "0";
      try {
        startTime = parseSimulateValue(json, "pool_open_time");
      } catch (error) {
        startTime = "0";
      }

      return {
        status,
        baseDecimals,
        quoteDecimals,
        lpDecimals,
        baseReserve,
        quoteReserve,
        lpSupply,
        startTime: new BN(startTime),
      };
    });

    return poolsInfo;
  }

  public async sdkParseJsonLiquidityInfo(
    liquidityJsonInfos: ApiLiquidityPoolInfo[],
  ): Promise<SDKParsedLiquidityInfo[]> {
    if (!liquidityJsonInfos.length) return [];

    const key = liquidityJsonInfos.map((jsonInfo) => jsonInfo.id).join("-");
    if (this._sdkParseInfoCache.has(key)) return this._sdkParseInfoCache.get(key)!;
    try {
      const info = await this.fetchMultipleLiquidityInfo({ pools: liquidityJsonInfos.map(jsonInfo2PoolKeys) });
      const result = info.map((sdkParsed, idx) => ({
        jsonInfo: liquidityJsonInfos[idx],
        ...jsonInfo2PoolKeys(liquidityJsonInfos[idx]),
        ...sdkParsed,
      }));
      this._sdkParseInfoCache.set(key, result);
      return result;
    } catch (err) {
      console.error(err);
      return [];
    }
  }

  public computeAmountOut({
    poolKeys,
    poolInfo,
    amountIn,
    currencyOut,
    slippage,
  }: LiquidityComputeAmountOutParams): LiquidityComputeAmountOutReturn {
    const logger = createLogger("Liquidity computeAmountOut");
    const tokenIn = amountIn instanceof TokenAmount ? amountIn.token : Token.WSOL;
    const tokenOut = currencyOut instanceof Token ? currencyOut : Token.WSOL;
    if (!includesToken(tokenIn, poolKeys) || !includesToken(tokenOut, poolKeys))
      logger.logWithError("token not match with pool", "poolKeys", poolKeys);

    const { baseReserve, quoteReserve } = poolInfo;
    logger.debug("baseReserve:", baseReserve.toString());
    logger.debug("quoteReserve:", quoteReserve.toString());

    const currencyIn = amountIn instanceof TokenAmount ? amountIn.token : amountIn.currency;
    logger.debug("currencyIn:", currencyIn);
    logger.debug("amountIn:", amountIn.toFixed());
    logger.debug("currencyOut:", currencyOut);
    logger.debug("slippage:", `${slippage.toSignificant()}%`);

    const reserves = [baseReserve, quoteReserve];
    const input = getAmountSide(amountIn, poolKeys);
    if (input === "quote") {
      reserves.reverse();
    }
    logger.debug("input side:", input);

    const [reserveIn, reserveOut] = reserves;
    let currentPrice;
    if (poolKeys.version === 4) {
      currentPrice = new Price({
        baseCurrency: currencyIn,
        denominator: reserveIn,
        quoteCurrency: currencyOut,
        numerator: reserveOut,
      });
    } else {
      const p = getStablePrice(stableModelData, baseReserve.toNumber(), quoteReserve.toNumber(), false);
      if (input === "quote")
        currentPrice = new Price({
          baseCurrency: currencyIn,
          denominator: new BN(p * 1e6),
          quoteCurrency: currencyOut,
          numerator: new BN(1e6),
        });
      else
        currentPrice = new Price({
          baseCurrency: currencyIn,
          denominator: new BN(1e6),
          quoteCurrency: currencyOut,
          numerator: new BN(p * 1e6),
        });
    }
    logger.debug("currentPrice:", `1 ${currencyIn.symbol} ≈ ${currentPrice.toFixed()} ${currencyOut.symbol}`);
    logger.debug(
      "currentPrice invert:",
      `1 ${currencyOut.symbol} ≈ ${currentPrice.invert().toFixed()} ${currencyIn.symbol}`,
    );

    const amountInRaw = amountIn.raw;
    let amountOutRaw = BN_ZERO;
    let feeRaw = BN_ZERO;

    if (!amountInRaw.isZero()) {
      if (poolKeys.version === 4) {
        feeRaw = amountInRaw.mul(LIQUIDITY_FEES_NUMERATOR).div(LIQUIDITY_FEES_DENOMINATOR);
        const amountInWithFee = amountInRaw.sub(feeRaw);

        const denominator = reserveIn.add(amountInWithFee);
        amountOutRaw = reserveOut.mul(amountInWithFee).div(denominator);
      } else {
        feeRaw = amountInRaw.mul(new BN(2)).div(new BN(10000));
        const amountInWithFee = amountInRaw.sub(feeRaw);
        if (input === "quote")
          amountOutRaw = new BN(
            getDyByDxBaseIn(
              stableModelData,
              quoteReserve.toNumber(),
              baseReserve.toNumber(),
              amountInWithFee.toNumber(),
            ),
          );
        else {
          amountOutRaw = new BN(
            getDxByDyBaseIn(
              stableModelData,
              quoteReserve.toNumber(),
              baseReserve.toNumber(),
              amountInWithFee.toNumber(),
            ),
          );
        }
      }
    }

    const _slippage = new Percent(BN_ONE).add(slippage);
    const minAmountOutRaw = _slippage.invert().mul(amountOutRaw).quotient;
    const amountOut =
      currencyOut instanceof Token
        ? new TokenAmount(currencyOut, amountOutRaw)
        : new CurrencyAmount(currencyOut, amountOutRaw);
    const minAmountOut =
      currencyOut instanceof Token
        ? new TokenAmount(currencyOut, minAmountOutRaw)
        : new CurrencyAmount(currencyOut, minAmountOutRaw);
    logger.debug("amountOut:", amountOut.toFixed());
    logger.debug("minAmountOut:", minAmountOut.toFixed());

    let executionPrice = new Price({
      baseCurrency: currencyIn,
      denominator: amountInRaw.sub(feeRaw),
      quoteCurrency: currencyOut,
      numerator: amountOutRaw,
    });
    if (!amountInRaw.isZero() && !amountOutRaw.isZero()) {
      executionPrice = new Price({
        baseCurrency: currencyIn,
        denominator: amountInRaw.sub(feeRaw),
        quoteCurrency: currencyOut,
        numerator: amountOutRaw,
      });
      logger.debug("executionPrice:", `1 ${currencyIn.symbol} ≈ ${executionPrice.toFixed()} ${currencyOut.symbol}`);
      logger.debug(
        "executionPrice invert:",
        `1 ${currencyOut.symbol} ≈ ${executionPrice.invert().toFixed()} ${currencyIn.symbol}`,
      );
    }

    const priceImpact = new Percent(
      parseInt(String(Math.abs(parseFloat(executionPrice.toFixed()) - parseFloat(currentPrice.toFixed())) * 1e9)),
      parseInt(String(parseFloat(currentPrice.toFixed()) * 1e9)),
    );

    const fee =
      currencyIn instanceof Token ? new TokenAmount(currencyIn, feeRaw) : new CurrencyAmount(currencyIn, feeRaw);

    return {
      amountOut,
      minAmountOut,
      currentPrice,
      executionPrice,
      priceImpact,
      fee,
    };
  }
}