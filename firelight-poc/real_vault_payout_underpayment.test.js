const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { time } = require('@nomicfoundation/hardhat-network-helpers')
const { expect } = require('chai')
const { ethers, upgrades } = require('hardhat')

/**
 * Firelight payout pricing, tested against the real FirelightVault.
 *
 * Setup: the vault holds 1000 asset units ($1000 at $1). An incident is
 * captured for the current period with an assessed loss of $1000 (canonical).
 *
 *   oracle $1.00 at approve -> vault pays 1000 units = $1000
 *   oracle $0.50 at approve -> vault requests 2000 units, capped at
 *                              totalAssetsAt(capturePeriodStart) = 1000 units
 *                              -> 1000 units x $0.50 = $500
 *
 * The third test applies the mitigation from the original report (convert
 * with the price locked at capture, $1.00) while the market price has fallen
 * to $0.50. The holder still receives $500, which is why the report was
 * closed: the shortfall comes from the collateral's value, not from when the
 * price is read.
 */
describe('Firelight payout pricing (real vault)', function () {
  this.timeout(180000)
  const e18 = (n) => ethers.parseUnits(n.toString(), 18)
  const PRICE_FEED_DECIMALS = 8n
  const PERIOD_DURATION = 86400 // must be a multiple of 1 day
  const ONE_DOLLAR = 10n ** 8n
  const HALF_DOLLAR = 5n * 10n ** 7n

  async function deployRealVaultScenario(oraclePriceAtApprove) {
    const [deployer] = await ethers.getSigners()

    // Vault asset (18 decimals)
    const MockERC20 = await ethers.getContractFactory('MockERC20')
    const asset = await MockERC20.connect(deployer).deploy('MockVaultAsset', 'mVA', 18)

    // Real FirelightVault (upgradeable proxy)
    const abiCoder = ethers.AbiCoder.defaultAbiCoder()
    const FirelightVaultFactory = await ethers.getContractFactory('FirelightVault')
    const initParams = abiCoder.encode(
      ['address', 'address', 'address', 'address', 'address', 'address', 'uint256', 'uint48'],
      [
        deployer.address, // defaultAdmin
        deployer.address, // limitUpdater
        deployer.address, // blocklister
        deployer.address, // pauser
        deployer.address, // periodConfigurationUpdater
        deployer.address, // rescuer
        e18(1_000_000), // depositLimit
        PERIOD_DURATION,
      ]
    )
    const vault = await upgrades.deployProxy(FirelightVaultFactory, [
      asset.target,
      'Firelight Vault',
      'fVAULT',
      initParams,
    ])

    // IncidentManager dependencies (mock allocator wired to the real vault)
    const firstLossBufferToken = await MockERC20.connect(deployer).deploy('MockUSDC', 'mUSDC', 6)
    const firstLossBufferPayer = ethers.Wallet.createRandom().connect(ethers.provider)
    await ethers.provider.send('hardhat_setBalance', [firstLossBufferPayer.address, '0x3635C9ADC5DEA00000'])

    const MockCoverOrderAllocator = await ethers.getContractFactory('MockIncidentManagerCoverOrderAllocator')
    const coverOrderAllocator = await MockCoverOrderAllocator.connect(deployer).deploy()
    await coverOrderAllocator.setVault(vault.target)
    await coverOrderAllocator.setCanonicalDecimals(18)
    await coverOrderAllocator.setMockCapacityConfig({
      minCAR: 10000,
      firstLossBufferToken: firstLossBufferToken.target,
      firstLossBuffer: firstLossBufferPayer.address, // unfunded, so the vault pays everything
      effectiveLeverage: 20000,
      minOrderMarketCoverAmount: 1,
      divergenceToleranceBps: 0,
    })

    const MockPriceFeed = await ethers.getContractFactory('MockPriceFeed')
    const priceFeed = await MockPriceFeed.connect(deployer).deploy(Number(PRICE_FEED_DECIMALS), ONE_DOLLAR)

    const maxPriceAge = 3600
    const funded = async () => {
      const w = ethers.Wallet.createRandom().connect(ethers.provider)
      await ethers.provider.send('hardhat_setBalance', [w.address, '0x3635C9ADC5DEA00000'])
      return w
    }
    const curator = await funded()
    const assessmentApprover = await funded()
    const assessmentRejecter = await funded()
    const incidentInvalidator = await funded()
    const payoutReceiver = await funded()

    const IncidentManagerFactory = await ethers.getContractFactory('IncidentManager')
    const incidentManager = await upgrades.deployProxy(
      IncidentManagerFactory,
      [
        deployer.address, // admin
        curator.address,
        assessmentApprover.address,
        assessmentRejecter.address,
        incidentInvalidator.address,
        deployer.address, // configAdmin
        deployer.address, // payoutAdmin
        deployer.address, // priceFeedAdmin
        payoutReceiver.address,
        coverOrderAllocator.target,
        priceFeed.target,
        maxPriceAge,
      ],
      { kind: 'transparent', unsafeAllow: ['missing-initializer-call'] }
    )

    // Let IncidentManager pay out from the real vault
    await vault.connect(deployer).grantRole(await vault.PAYOUT_ROLE(), incidentManager.target)
    await vault.connect(deployer).grantRole(await vault.INCIDENT_ROLE(), incidentManager.target)
    const allowlister = await funded()
    await vault.connect(deployer).grantRole(await vault.PAYOUT_ALLOWLIST_ROLE(), allowlister.address)
    await vault.connect(allowlister).addToPayoutAllowlist(payoutReceiver.address)

    // Fund the vault with 1000 units in period 0
    const principal = e18(1000)
    await asset.mint(deployer.address, principal)
    await asset.connect(deployer).approve(vault.target, principal)
    await vault.connect(deployer).deposit(principal, deployer.address)

    // Move into period 1 and capture the incident there
    await time.increase(PERIOD_DURATION + 1)
    const captureTimestamp = (await ethers.provider.getBlock('latest')).timestamp
    const period = await vault.periodAtTimestamp(captureTimestamp)
    expect(period).to.equal(1n)

    const refOf = (s) => ethers.keccak256(ethers.toUtf8Bytes(s))
    const marketIdA = ethers.id('market-A')
    await incidentManager.connect(curator).createIncident(captureTimestamp, 'A', refOf('a'))
    await incidentManager.connect(curator).confirmIncident(1, 'ipfs://r')
    await coverOrderAllocator.setOrderMarket(1, marketIdA, period, e18(5000), payoutReceiver.address)
    const loss = e18(1000)
    await incidentManager
      .connect(curator)
      .addAssessmentLosses(1, [{ coverTokenId: 1, marketId: marketIdA, amount: loss }])
    await incidentManager.connect(curator).submitCurrentAssessment(1)

    // The price the contract reads when the approver executes
    const now = (await ethers.provider.getBlock('latest')).timestamp
    await priceFeed.setLatestRoundData(1, oraclePriceAtApprove, now, now, 1)

    const receipt = await (await incidentManager.connect(assessmentApprover).approveCurrentAssessment(1)).wait()
    const ev = receipt.logs
      .map((l) => {
        try {
          return incidentManager.interface.parseLog(l)
        } catch {
          return null
        }
      })
      .find((p) => p && p.name === 'IncidentPayoutExecuted')

    return {
      vaultRequestedUnits: ev.args.vaultRequestedAmount,
      vaultPaidUnits: ev.args.vaultPaidAmount,
      receivedUnits: await asset.balanceOf(payoutReceiver.address),
      loss,
    }
  }

  const usdAt = (units, price) => (units * price) / 10n ** PRICE_FEED_DECIMALS

  async function oracleOneDollar() {
    return deployRealVaultScenario(ONE_DOLLAR)
  }
  async function oracleHalfDollar() {
    return deployRealVaultScenario(HALF_DOLLAR)
  }

  it('price $1 at approve: holder receives the full $1000', async function () {
    const ctx = await loadFixture(oracleOneDollar)
    expect(ctx.vaultPaidUnits).to.equal(ctx.loss)
    expect(ctx.receivedUnits).to.equal(ctx.loss)
    expect(usdAt(ctx.receivedUnits, ONE_DOLLAR)).to.equal(ctx.loss)
  })

  it('price $0.50 at approve: vault requests 2000 units, pays 1000 (= $500)', async function () {
    const ctx = await loadFixture(oracleHalfDollar)
    expect(ctx.vaultRequestedUnits).to.equal(ctx.loss * 2n)
    expect(ctx.vaultPaidUnits).to.equal(ctx.loss) // capped at units at capture
    expect(usdAt(ctx.receivedUnits, HALF_DOLLAR)).to.equal(ctx.loss / 2n)
    console.log('      units requested / paid :', ctx.vaultRequestedUnits.toString(), '/', ctx.vaultPaidUnits.toString())
    console.log('      USD received at $0.50  :', usdAt(ctx.receivedUnits, HALF_DOLLAR).toString())
  })

  it('with the proposed fix (price locked at capture, $1) and market at $0.50: still $500', async function () {
    // The fix would make _executePayout convert with the capture price ($1),
    // so the contract sees $1 here. The holder's units are then worth the
    // real market price, $0.50.
    const ctx = await loadFixture(oracleOneDollar)
    expect(ctx.vaultRequestedUnits).to.equal(ctx.loss) // 1000 units, under the cap
    expect(ctx.vaultPaidUnits).to.equal(ctx.loss)
    const usdReceived = usdAt(ctx.receivedUnits, HALF_DOLLAR)
    expect(usdReceived).to.equal(ctx.loss / 2n) // same $500 shortfall as without the fix
    console.log('      USD received with fix  :', usdReceived.toString())
  })
})
