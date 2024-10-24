const conf = require('ocore/conf.js');
const db = require('ocore/db.js');
const express = require('express')
const cors = require('cors');
const mutex = require('ocore/mutex.js');
const addZero = require('./helpers/addZero');
const getBalancesByAddress = require('./helpers/getBalancesByAddress');
const updateBalancesForOneAddress = require('./updateBalancesForOneAddress')
const getExchangeRates = require('./rates');

const assocTickersByAssets = {};
const assocTickersByMarketNames = {};

const assocTradesByAssets = {};
const assocTradesByMarketNames = {};

const assocIdsByMarketNames = {}

var assocAssets = {};
var assocAssetsBySymbols = {};

const unifiedCryptoAssetIdsByAssets = {
	base: { 
		id: 1492,
		name: 'Obyte'
	}
}

var bRefreshing = false;

async function initMarkets(){
	await initAssetsCache();
	const rows = await db.query('SELECT address, asset_0, asset_1 FROM oswap_aas');
	for (let i=0; i < rows.length; i++){
		await refreshMarket(rows[i].address, rows[i].asset_1, rows[i].asset_0)
	}
}

async function initAssetsCache(){
	var rows = await db.query("SELECT * FROM oswap_assets LEFT JOIN supplies USING(asset)");
	assocAssets = {};
	rows.forEach(function(row){
		setAsset(row);
	});
}
function setAsset(row){
	if (!row)
		return;
	assocAssets[row.asset] = {
		symbol: row.symbol,
		decimals: row.decimals,
	};

	assocAssetsBySymbols[row.symbol] = {
		asset_id: row.asset,
		decimals: row.decimals,
		description: row.description,
		symbol: row.symbol,
		fee: row.fee,
	};

	if (row.supply)
		assocAssetsBySymbols[row.symbol].supply = row.supply / 10 ** row.decimals;
		
	if (unifiedCryptoAssetIdsByAssets[row.asset]){
		assocAssetsBySymbols[row.symbol].unified_cryptoasset_id = unifiedCryptoAssetIdsByAssets[row.asset].id;
		assocAssetsBySymbols[row.symbol].name = unifiedCryptoAssetIdsByAssets[row.asset].name;
	}
}

function getMarketNameSeparator(){
	return "-";
}

function getFullMarketName(address, baseSymbol, quoteSymbol) {
	return address + getMarketNameSeparator() + baseSymbol + getMarketNameSeparator() + quoteSymbol;
}

function getKeyName(address, base, quote) {
	return address + '-' + base + '-' + quote;
}

function getDecimalsPriceCoefficient(base, quote){
	return 10 ** (assocAssets[base].decimals - assocAssets[quote].decimals);
}

async function createTicker(address, base, quote){
	if (assocAssets[base] && assocAssets[quote]){

		const full_market_name = getFullMarketName(address, assocAssets[base].symbol, assocAssets[quote].symbol);
		const market_name = assocAssets[base].symbol + getMarketNameSeparator() + assocAssets[quote].symbol;
		
		if(!assocIdsByMarketNames[market_name]) {
			assocIdsByMarketNames[market_name] = {
				base_id: base,
				quote_id: quote,
			}
		}
		
		const ticker = {
			address,
			full_market_name: full_market_name,
			market_name,
			quote_symbol: assocAssets[quote].symbol,
			base_symbol: assocAssets[base].symbol,
			quote_id: quote,
			base_id: base,
		};

		assocTickersByAssets[getKeyName(address, base, quote)] = ticker;
		assocTickersByMarketNames[full_market_name] = ticker;

		const trades = [];
		assocTradesByAssets[getKeyName(address, base, quote)] = trades;
		assocTradesByMarketNames[full_market_name] = trades;
		return true;
	}
	else {
		delete assocTickersByAssets[getKeyName(address, base, quote)]; // we remove from api any ticker that has lost a symbol
		return false;
	}
}

async function refreshMarket(address, base, quote){
	const unlock = await mutex.lockOrSkip(['refresh_' + address]);
	if (!unlock)
		return;
	bRefreshing = true;
	await refreshAsset(base);
	await refreshAsset(quote);
	if (await createTicker(address, base, quote)){
		await refreshTrades(address, base, quote);
		await refreshTicker(address, base, quote);
		await makeNextCandlesForMarket(address, base, quote);
	} else 
		console.log("symbol missing");
	bRefreshing = false;
	unlock();
}

async function refreshAsset(asset){
	var rows = await db.query("SELECT * FROM oswap_assets LEFT JOIN supplies USING(asset) WHERE oswap_assets.asset=?", [asset]);
	setAsset(rows[0]);
}

function getOneDayAgoDate() {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - 1);
	return d.toISOString();
}


async function refreshTrades(address, base, quote){
	const ticker = assocTickersByAssets[getKeyName(address, base, quote)];
	if (!ticker)
		return console.log(getKeyName(address, base, quote) + " not found in assocTickersByAssets")
	
	const trades = assocTradesByAssets[getKeyName(address, base, quote)];

	trades.length = 0; // we clear array without deferencing it

	var rows = await db.query("SELECT quote_qty*1.0/base_qty AS price,base_qty AS base_volume,quote_qty AS quote_volume,timestamp,response_unit,indice,type,timestamp FROM trades \n\
	WHERE timestamp > ? AND quote=? AND base=? AND aa_address=? ORDER BY timestamp DESC", [getOneDayAgoDate(), quote, base, address]);
	rows.forEach(function(row){
		trades.push({
			full_market_name: getFullMarketName(address, ticker.base_symbol, ticker.quote_symbol),
			market_name: ticker.base_symbol + getMarketNameSeparator() + ticker.quote_symbol,
			price: row.price * getDecimalsPriceCoefficient(base, quote),
			base_volume: row.base_volume / 10 ** assocAssets[base].decimals,
			quote_volume: row.quote_volume / 10 ** assocAssets[quote].decimals,
			time: row.timestamp,
			timestamp: (new Date(row.timestamp)).getTime(),
			trade_id: row.response_unit + '_' + row.indice,
			type: row.type,
			explorer: conf.explorer_base_url + row.response_unit
		});
	});

}

async function refreshTicker(address, base, quote){
	const ticker = assocTickersByAssets[getKeyName(address, base, quote)];
	if (!ticker)
		return console.log(getKeyName(address, base, quote) + " not found in assocTickersByAssets")
	
	const date = getOneDayAgoDate();

	var rows = await db.query("SELECT MIN(quote_qty*1.0/base_qty) AS low FROM trades WHERE timestamp > ? AND quote=? AND base=? AND aa_address=?", [date, quote, base, address]);
	if (rows[0])
		ticker.lowest_price_24h = rows[0].low * getDecimalsPriceCoefficient(base, quote);
	else
		delete ticker.lowest_price_24h;

	rows = await db.query("SELECT MAX(quote_qty*1.0/base_qty) AS high FROM trades WHERE timestamp > ? AND quote=? AND base=? AND aa_address=?", [date, quote, base, address]);
	if (rows[0])
		ticker.highest_price_24h = rows[0].high * getDecimalsPriceCoefficient(base, quote);
	else
		delete ticker.highest_price_24h;

	rows = await db.query("SELECT quote_qty*1.0/base_qty AS last_price FROM trades WHERE quote=? AND base=? ORDER BY timestamp DESC LIMIT 1",[quote, base]);
	if (rows[0])
		ticker.last_price = rows[0].last_price * getDecimalsPriceCoefficient(base, quote);

	rows = await db.query("SELECT SUM(quote_qty) AS quote_volume FROM trades WHERE timestamp > ? AND quote=? AND base=? AND aa_address=?", [date, quote, base, address]);
	if (rows[0])
		ticker.quote_volume = rows[0].quote_volume  / 10 ** assocAssets[quote].decimals;
	else
		ticker.quote_volume = 0;

	rows = await db.query("SELECT SUM(base_qty) AS base_volume FROM trades WHERE timestamp > ? AND quote=? AND base=? AND aa_address=?", [date, quote, base, address]);
		if (rows[0])
			ticker.base_volume = rows[0].base_volume  / 10 ** assocAssets[base].decimals;
		else
			ticker.base_volume = 0;

	rows = await db.query("SELECT SUM(base_qty) AS base_volume FROM trades WHERE timestamp > ? AND quote=? AND base=? AND aa_address=?", [date, quote, base, address]);
			if (rows[0])
				ticker.base_volume = rows[0].base_volume  / 10 ** assocAssets[base].decimals;
			else
				ticker.base_volume = 0;
}



async function makeNextCandlesForMarket(address, base, quote){
	await makeNextHourlyCandlesForMarket(address, base, quote, true);
	await makeNextDailyCandlesForMarket(address, base, quote, true);
}

async function makeNextDailyCandlesForMarket(address, base, quote, bReplaceLastCandle){
	var last_start_timestamp,last_end_timestamp,next_end_timestamp;
	
	const candles = await db.query("SELECT start_timestamp AS last_start_timestamp, \n\
	strftime('%Y-%m-%dT%H:00:00.000Z', start_timestamp, '+24 hours') AS last_end_timestamp, \n\
	strftime('%Y-%m-%dT%H:00:00.000Z', start_timestamp, '+48 hours') AS next_end_timestamp \n\
	FROM daily_candles WHERE base=? AND quote=? AND aa_address=? ORDER BY start_timestamp DESC LIMIT 1", [base,quote, address]);

	if (candles[0]){
		last_start_timestamp = candles[0].last_start_timestamp;
		last_end_timestamp = candles[0].last_end_timestamp;
		next_end_timestamp = candles[0].next_end_timestamp;
	} else { // if no candle exists yet, we find the first candle time start
		const trades = await db.query("SELECT strftime('%Y-%m-%dT00:00:00.000Z',timestamp) AS last_start_timestamp, strftime('%Y-%m-%dT00:00:00.000Z', DATETIME(timestamp, '+24 hours')) AS last_end_timestamp\n\
		FROM trades WHERE base=? AND quote=? AND aa_address=? ORDER BY timestamp ASC LIMIT 1", [base, quote, address]);
		if (!trades[0])
			return console.log("no trade yet for " + base + " - " + quote);
		last_start_timestamp = trades[0].last_start_timestamp;
		last_end_timestamp = trades[0].last_end_timestamp;
	}

	
	if (last_end_timestamp > (new Date()).toISOString()) {
		await makeCandleForPair('daily_candles', last_start_timestamp, last_end_timestamp, base, quote, address);
		return; // current candle not closed yet
	}
	if (bReplaceLastCandle)
		await makeCandleForPair('daily_candles', last_start_timestamp, last_end_timestamp, base, quote, address);
	else
		await makeCandleForPair('daily_candles', last_end_timestamp, next_end_timestamp, base, quote, address);

	await makeNextDailyCandlesForMarket(address, base, quote);
}


async function makeNextHourlyCandlesForMarket(address, base, quote, bReplaceLastCandle){
	var last_start_timestamp,last_end_timestamp,next_end_timestamp;
	
	const candles = await db.query("SELECT start_timestamp AS last_start_timestamp, \n\
	strftime('%Y-%m-%dT%H:00:00.000Z', start_timestamp, '+1 hour') AS last_end_timestamp, \n\
	strftime('%Y-%m-%dT%H:00:00.000Z', start_timestamp, '+2 hours') AS next_end_timestamp \n\
	FROM hourly_candles WHERE base=? AND quote=? AND aa_address=? ORDER BY start_timestamp DESC LIMIT 1", [base, quote, address]);

	if (candles[0]){
		last_start_timestamp = candles[0].last_start_timestamp;
		last_end_timestamp = candles[0].last_end_timestamp;
		next_end_timestamp = candles[0].next_end_timestamp;
	} else { // if no candle exists yet, we find the first candle time start
		const trades = await db.query("SELECT strftime('%Y-%m-%dT%H:00:00.000Z',timestamp) AS last_start_timestamp, strftime('%Y-%m-%dT%H:00:00.000Z', DATETIME(timestamp, '+1 hour')) AS last_end_timestamp\n\
		FROM trades WHERE base=? AND quote=? AND aa_address=? ORDER BY timestamp ASC LIMIT 1", [base, quote, address]);
		if (!trades[0])
			return console.log("no trade yet for " + base + " - " + quote);
		last_start_timestamp = trades[0].last_start_timestamp;
		last_end_timestamp = trades[0].last_end_timestamp;
	}
	if (last_end_timestamp > (new Date()).toISOString())
		return; // current candle not closed yet
	if (bReplaceLastCandle)
		await makeCandleForPair('hourly_candles', last_start_timestamp, last_end_timestamp, base, quote, address);
	else
		await makeCandleForPair('hourly_candles', last_end_timestamp, next_end_timestamp, base, quote, address);

	await makeNextHourlyCandlesForMarket(address, base, quote);

}

async function makeCandleForPair(table_name, start_timestamp, end_timestamp, base, quote, aa_address){
	var low, high, open_price, close_price;
	var quote_volume, base_volume = 0;

	var rows = await db.query("SELECT MIN(quote_qty*1.0/base_qty) AS low,MAX(quote_qty*1.0/base_qty) AS high,SUM(quote_qty) AS quote_volume,SUM(base_qty) AS base_volume \n\
	FROM trades WHERE timestamp >=? AND timestamp <?  AND quote=? AND base=? AND aa_address=?",[start_timestamp, end_timestamp, quote, base, aa_address]);

	if (rows[0] && rows[0].low){
		low = rows[0].low * getDecimalsPriceCoefficient(base, quote);
		high = rows[0].high * getDecimalsPriceCoefficient(base, quote);
		quote_volume = rows[0].quote_volume  / 10 ** assocAssets[quote].decimals;
		base_volume = rows[0].base_volume  / 10 ** assocAssets[base].decimals;

		rows = await db.query("SELECT quote_qty*1.0/base_qty AS open_price FROM trades WHERE timestamp >=? AND quote=? AND base=? AND aa_address=? \n\
		ORDER BY timestamp ASC LIMIT 1" ,[start_timestamp, quote, base, aa_address]);

		open_price = rows[0].open_price * getDecimalsPriceCoefficient(base, quote);
		rows = await db.query("SELECT quote_qty*1.0/base_qty AS close_price FROM trades WHERE timestamp <? AND quote=? AND base=? AND aa_address=? \n\
		ORDER BY timestamp DESC LIMIT 1", [end_timestamp, quote, base, aa_address]);
		close_price = rows[0].close_price * getDecimalsPriceCoefficient(base, quote);

	} else {
		rows = await db.query("SELECT close_price FROM " + table_name + " WHERE start_timestamp <? AND quote=? AND base=? AND aa_address=? ORDER BY start_timestamp DESC LIMIT 1",
		[start_timestamp, quote, base, aa_address]);
		low = rows[0].close_price;
		high = rows[0].close_price;
		open_price = rows[0].close_price;
		close_price = rows[0].close_price;
		quote_volume = 0;
		base_volume = 0;
	}

	await db.query("REPLACE INTO " + table_name + " (base,quote,aa_address,quote_qty,base_qty,highest_price,lowest_price,open_price,close_price,start_timestamp)\n\
	VALUES (?,?,?,?,?,?,?,?,?,?)",[ base, quote, aa_address, quote_volume, base_volume, high, low, open_price, close_price,start_timestamp]);
}

async function calcBalancesOfAddressWithSlicesByDate(address, start_time, end_time, is_repeat) {
	const start = start_time.getUTCFullYear() + '-' + addZero(start_time.getUTCMonth() +1) + '-' + addZero(start_time.getUTCDate())+' 00:00:00';
	const end = end_time.getUTCFullYear() + '-' + addZero(end_time.getUTCMonth() +1) + '-' + addZero(end_time.getUTCDate())+' 23:59:59';
	const rows = await db.query("SELECT * FROM oswap_aa_balances WHERE address = ? \n\
	AND balance_date >= ? AND balance_date <= ? ORDER BY balance_date ASC", [address, start, end]);
	
	const assocDateToBalances = {};
	rows.forEach(row => {
		if(!assocDateToBalances[row.balance_date]) {
			assocDateToBalances[row.balance_date] = {
				balance_date: row.balance_date
			}
		}
		assocDateToBalances[row.balance_date][row.asset] = row.balance;
	})
	
	if(!assocDateToBalances[end] && !is_repeat) {
		await updateBalancesForOneAddress(address);
		return calcBalancesOfAddressWithSlicesByDate(address, start_time, end_time, true);
	}
	return Object.values(assocDateToBalances)
}

async function getCandles(period, start_time, end_time, quote_id, base_id, address) {
	return db.query("SELECT quote_qty AS quote_volume,base_qty AS base_volume,highest_price,lowest_price,open_price,close_price,start_timestamp\n\
	FROM " + period + "_candles WHERE start_timestamp>=? AND start_timestamp<? AND quote=? AND base=? AND aa_address=?",
	[start_time.toISOString(), end_time.toISOString(), quote_id, base_id, address])
}

function assetValue(value, asset) {
	const decimals = asset ? asset.decimals : 0;
	return value / 10 ** decimals;
}

function getMarketcap(balances, asset0, asset1) {
	let assetValue0 = 0;
	let assetValue1 = 0;
	let base = 0;
	if (asset0 === 'base' || asset1 === 'base') base = balances.base;

	if (base) {
		assetValue0 = assetValue1 =
			(getExchangeRates().GBYTE_USD / 1e9) * base;
	} else {
		const assetId0 = asset0 === "base" ? "GBYTE" : asset0;
		const assetId1 = asset1 === "base" ? "GBYTE" : asset1;
		const assetInfo0 = assocAssets[asset0];
		const assetInfo1 = assocAssets[asset1];
		assetValue0 = getExchangeRates()[`${assetId0}_USD`]
			? getExchangeRates()[`${assetId0}_USD`] *
			assetValue(balances[assetId0], assetInfo0)
			: 0;
		assetValue1 = getExchangeRates()[`${assetId1}_USD`]
			? getExchangeRates()[`${assetId1}_USD`] *
			assetValue(balances[assetId1], assetInfo1)
			: 0;
	}
	return assetValue0 && assetValue1 ? assetValue0 + assetValue1 : 0;
}

async function getAPY7d(endTime, quote_id, base_id, address, balances, fee) {
	const startTime = new Date(endTime);
	startTime.setUTCDate(startTime.getUTCDate() - 7);

	const candles = await getCandles('daily', startTime, endTime, quote_id, base_id, address);
	const marketCap = getMarketcap(balances, quote_id, base_id);

	let asset = quote_id === 'base' ? 'GBYTE' : quote_id;
	let type = "quote";
	let rate = getExchangeRates()[`${asset}_USD`];
	if (!rate) {
		asset = base_id === 'base' ? 'GBYTE' : base_id;
		type = "base";
		rate = getExchangeRates()[`${asset}_USD`];
	}

	const earning7d = candles
	.map((c) => {
		const volume = type === "quote" ? c.quote_volume : c.base_volume;
		const inUSD = volume * rate;
		return inUSD * fee;
	})
	.reduce((prev, curr) => prev + curr, 0);

	const apy = (1 + earning7d / marketCap) ** (365 / 7) - 1;
	
	return Number((apy * 100).toFixed(2)) || 0;
}

async function getPoolHistory(address) {
	return db.query("SELECT * FROM pool_history WHERE aa_address=? ORDER BY timestamp DESC LIMIT 20", [address]);
}

async function getTheMostLiquidAddress(marketName) {
	if (assocIdsByMarketNames[marketName]) {
		const {base_id, quote_id} = assocIdsByMarketNames[marketName];
		let bestAddressData = {address: false, balance: 0}
		const rows = await db.query("SELECT address FROM oswap_aas WHERE asset_0=? AND asset_1=?", [quote_id, base_id]);
		if (rows.length === 1)
			return rows[0].address;
		for (let row of rows) {
			const lRows = await db.query("SELECT balance FROM oswap_aa_balances WHERE address=? AND asset=? \
				ORDER BY balance_date DESC LIMIT 1", [row.address, quote_id === 'base' ? 'GBYTE' : quote_id]);

			if (lRows.length) {
				if (lRows[0].balance > bestAddressData.balance) {
					bestAddressData = {
						address: row.address,
						balance: lRows[0].balance,
					}
				}
			}
		}
		if (!bestAddressData.address) return false;
		return bestAddressData.address;
	}
	return false;
}

async function sendTickerByFullMarketName(fullMarketName, response) {
	if (fullMarketName && assocTickersByMarketNames[fullMarketName]){
		await waitUntilRefreshFinished();
		return response.send(assocTickersByMarketNames[fullMarketName]);
	}
	else
		return response.status(400).send('Unknown market');
}

async function sendTradesByFullMarketName(fullMarketName, response) {
	if (fullMarketName && assocTradesByMarketNames[fullMarketName]){
		await waitUntilRefreshFinished();
		return response.send(assocTradesByMarketNames[fullMarketName]);
	}
	else
		return response.status(400).send('Unknown market');
}

async function sendCandlesByFullMarketName(fullMarketName, period, start_time, end_time, response) {
	if (!start_time)
		return response.status(400).send('start_time not valid');
	if (!end_time)
		return response.status(400).send('end_time not valid');

	if (period !== 'hourly' && period !== 'daily')
		return response.status(400).send('period must be "daily" or "hourly"');
	if (assocTickersByMarketNames[fullMarketName]){
		await waitUntilRefreshFinished();

		const ticker = assocTickersByMarketNames[fullMarketName];
		const rows = await getCandles(period, start_time, end_time, ticker.quote_id, ticker.base_id, ticker.address);
		return response.send(rows);
	}
	else
		return response.status(400).send('Unknown market');
}

let started = false;

async function start(){
	if (started) return
	if (!started) started = true;
	const app = express();
	const server = require('http').Server(app);
	app.use(cors());

	await initMarkets();
	setInterval(initMarkets, 3600 * 1000); // compute last hourly candle even when no trade happened

	app.get('/', async function(request, response){
		return response.send(getLandingPage());
	});

	app.get('/api/v1/assets', async function(request, response){
		await waitUntilRefreshFinished();
		return response.send(assocAssetsBySymbols);
	});

	app.get('/api/v1/summary', async function(request, response){
		await waitUntilRefreshFinished();
		const arrSummary = [];
		for(var key in assocTickersByMarketNames)
			arrSummary.push(assocTickersByMarketNames[key]);
		return response.send(arrSummary);
	});

	app.get('/api/v1/tickers', async function(request, response){
		await waitUntilRefreshFinished();
		return response.send(assocTickersByMarketNames);
	});

	app.get('/api/v1/ticker/:marketName', async function(request, response){
		const marketName = request.params.marketName;
		const address = await getTheMostLiquidAddress(marketName);
		const fullMarketName = address ? address + getMarketNameSeparator() + marketName : false;

		await sendTickerByFullMarketName(fullMarketName, response)
	});
	
	app.get('/api/v1/ticker_by_full_market_name/:fullMarketName', async function(request, response){
		const fullMarketName = request.params.fullMarketName;

		await sendTickerByFullMarketName(fullMarketName, response)
	});

	app.get('/api/v1/trades/:marketName', async function(request, response){
		const marketName = request.params.marketName;
		const address = await getTheMostLiquidAddress(marketName);
		const fullMarketName = address ? address + getMarketNameSeparator() + marketName : false;
		
		await sendTradesByFullMarketName(fullMarketName, response);
	});

	app.get('/api/v1/trades_by_full_market_name/:fullMarketName', async function(request, response){
		const fullMarketName = request.params.fullMarketName;
		
		await sendTradesByFullMarketName(fullMarketName, response);
	});

	app.get('/api/v1/candles/:marketName', async function(request, response){
		const marketName = request.params.marketName;
		const address = await getTheMostLiquidAddress(marketName);
		const fullMarketName = address + getMarketNameSeparator() + marketName;
		const period = request.query.period;
		const start_time = parseDateTime(request.query.start);
		const end_time = parseDateTime(request.query.end, true);
		
		await sendCandlesByFullMarketName(fullMarketName, period, start_time, end_time, response);
	});

	app.get('/api/v1/candles_by_full_market_name/:fullMarketName', async function(request, response){
		const fullMarketName = request.params.fullMarketName;
		const period = request.query.period;
		const start_time = parseDateTime(request.query.start);
		const end_time = parseDateTime(request.query.end, true);
		
		await sendCandlesByFullMarketName(fullMarketName, period, start_time, end_time, response);
	});

	app.get('/api/v1/balances/:address', async function (request, response) {
		const address = request.params.address;
		const start_time = parseDateTime(request.query.start);
		const end_time = parseDateTime(request.query.end);

		if (!start_time)
			return response.status(400).send('start_time not valid');
		if (!end_time)
			return response.status(400).send('end_time not valid');

		response.send(await calcBalancesOfAddressWithSlicesByDate(address, start_time, end_time));
	});

	app.get('/api/v1/apy7d', async function (request, response) {
		const endTime = new Date();
		endTime.setUTCHours(0, 0, 0, 0);

		const assocAPYByMarketName = {};

		for (let key in assocTickersByMarketNames) {
			const q = assocTickersByMarketNames[key];
			
			const rows = await db.query("SELECT fee FROM oswap_aas WHERE address=?",
			[q.address]);

			if (!rows.length) {
				assocAPYByMarketName[q.address] = 0
			} else {
				const fee = rows[0].fee / 10 ** 11;
				const balances = await getBalancesByAddress(q.address);
				assocAPYByMarketName[q.address] = await getAPY7d(
					endTime,
					q.quote_id,
					q.base_id,
					q.address,
					balances,
					fee);
			}
		}
		response.send(assocAPYByMarketName);
	});

	app.get('/api/v1/exchangeRates', async function (request, response) {
		response.send(getExchangeRates());
	});

	app.get('/api/v1/history/:address', async function (request, response) {
		const address = request.params.address;

		const history = await getPoolHistory(address);

		response.send(history);
	});

	server.listen(conf.apiPort, () => {
		console.log(`== server started listening on ${conf.webServerPort} port`);
	});
}

function parseDateTime(string, bEndDate){

	if (typeof string !== 'string')
		return null;
	var date = null;
	if (string.match(/^\d\d\d\d-\d\d-\d\d$/)){
		date = new Date(Date.parse(string));
		if (bEndDate)
			date.setDate(date.getUTCDate() + 1); // make end day inclusive
		return date;
	}
	else if (string.match(/^\d\d\d\d-\d\d-\d\d( |T)\d\d:\d\d:\d\dZ$/))
		date = new Date(Date.parse(string));
	else if (string.match(/^\d\d\d\d-\d\d-\d\d( |T)\d\d:\d\d:\d\d.\d\d\dZ$/))
		date = new Date(Date.parse(string));
	else if (string.match(/^\d+$/))
		date = new Date(parseInt(string) / 1000);
	else
		return null;
	if (bEndDate)
		date.setUTCHours(date.getUTCHours() + 1); // make end hour inclusive
	return date;
}


function waitUntilRefreshFinished(){
	return new Promise(function(resolve){
		if (!bRefreshing)
			return resolve()
		else
			return setTimeout(function(){
				waitUntilRefreshFinished().then(resolve);
			}, 50);
	})
}

function getLandingPage(){
	var html = '<html><ul>';
	html +='<li><a href="/api/v1/assets">assets</a></li>';
	html +='<li><a href="/api/v1/summary">summary</a></li>';
	html +='<li><a href="/api/v1/tickers">tickers</a></li>';
	for (var key in assocTickersByMarketNames)
		html +='<li><a href="/api/v1/ticker/'+ key + '">ticker ' + key + ' </a></li>';
	for (var key in assocTickersByMarketNames)
		html +='<li><a href="/api/v1/trades/'+ key + '">trades ' + key + ' </a></li>';
	html += '</ul></html>';
	return html;
}


exports.start = start;
exports.refreshMarket = refreshMarket;
exports.initMarkets = initMarkets;
