import {
  FundTxOutput,
  Network,
  SubnetMap,
  SwapError,
  TxOutput,
} from '@radar/redshift-types';
import bip65 from 'bip65';
import {
  address,
  crypto,
  ECPair,
  payments,
  Psbt,
  script,
  Transaction,
} from 'bitcoinjs-lib';
import { Output } from 'bitcoinjs-lib/types/transaction';
import { isString } from 'util';
import { UTXO } from '../../types';
import { isDefined } from '../../utils';
import { BaseHtlc } from '../shared';
import {
  createSwapRedeemScript,
  estimateFee,
  getBitcoinJSNetwork,
  getSwapRedeemScriptDetails,
  isRefundPublicKeyHashRedeemScript,
  isRefundPublicKeyRedeemScript,
  toReversedByteOrderBuffer,
} from './utils';

export class UtxoHtlc<N extends Network> extends BaseHtlc<N> {
  private _redeemScript: string;
  private _details: UTXO.Details<N>;

  get redeemScript(): string {
    return this._redeemScript;
  }

  get redeemScriptBuffer(): Buffer {
    return Buffer.from(this.redeemScript, 'hex');
  }

  get details(): UTXO.Details<N> {
    return this._details;
  }

  /**
   * Create a new UTXO HTLC instance
   * @param network The chain network
   * @param subnet The chain subnet
   * @param config The redeem script or htlc creation config
   */
  constructor(network: N, subnet: SubnetMap[N], config: UTXO.Config) {
    super(network, subnet);
    this._redeemScript = isString(config)
      ? config
      : createSwapRedeemScript(config);

    this._details = getSwapRedeemScriptDetails(
      this._network,
      this._subnet,
      this._redeemScript,
    );
  }

  /**
   * Generate the funding transaction and return the raw tx hex
   * @param utxos The unspent funding tx outputs
   * @param amount The funding amount in satoshis
   * @param privateKey The private key WIF string used to sign
   * @param fee Fee tokens for the transaction
   */
  public fund(
    utxos: FundTxOutput[],
    amount: number,
    privateKey: string,
    fee: number = 0,
  ): string {
    const networkPayload = getBitcoinJSNetwork(this._network, this._subnet);
    const tx = new Psbt({
      network: networkPayload,
    });

    // The signing key
    const signingKey = ECPair.fromWIF(privateKey, networkPayload);

    // Get change address
    const { address } = payments.p2wpkh({
      pubkey: signingKey.publicKey,
      network: networkPayload,
    });
    if (!address) {
      throw new Error(SwapError.EXPECTED_ADDRESS);
    }

    // Add the inputs being spent to the transaction
    utxos.forEach(utxo => {
      const { txId, index, txHex, redeemScript, witnessScript } = utxo;
      if (isDefined(txId) && isDefined(index) && isDefined(txHex)) {
        tx.addInput({
          index,
          hash: toReversedByteOrderBuffer(txId),
          sequence: 0,
          nonWitnessUtxo: Buffer.from(txHex, 'hex'),
          ...(redeemScript ? { redeemScript } : {}),
          ...(witnessScript ? { witnessScript } : {}),
        });
      }
    });

    // Total spendable amount
    const tokens = utxos.reduce((t, c) => t + Number(c.tokens), 0);

    tx.addOutputs([
      {
        address: this.details.p2shP2wshAddress, // HTLC address
        value: amount,
      },
      {
        address, // Change address
        value: tokens - amount - fee,
      },
    ]);

    // Sign the inputs
    tx.signAllInputs(signingKey);

    return tx
      .finalizeAllInputs()
      .extractTransaction()
      .toHex();
  }

  /**
   * Generate the claim transaction and return the raw tx hex
   * @param utxos The unspent funding tx outputs
   * @param destinationAddress The address the funds will be claimed to
   * @param currentBlockHeight The current block height on the network
   * @param feeTokensPerVirtualByte The fee per byte (satoshi/byte)
   * @param paymentSecret The payment secret
   * @param privateKey The private key WIF string
   */
  public claim(
    utxos: TxOutput[],
    destinationAddress: string,
    currentBlockHeight: number,
    feeTokensPerVirtualByte: number,
    paymentSecret: string,
    privateKey: string,
  ): string {
    return this.buildTransaction(
      utxos,
      destinationAddress,
      currentBlockHeight,
      feeTokensPerVirtualByte,
      paymentSecret,
      privateKey,
      true,
    );
  }

  /**
   * Generate the refund transaction and return the raw tx hex
   * @param utxos The unspent funding tx outputs
   * @param destinationAddress The address the funds will be refunded to
   * @param currentBlockHeight The current block height on the network
   * @param feeTokensPerVirtualByte The fee per byte (satoshi/byte)
   * @param privateKey The private key WIF string
   */
  public refund(
    utxos: TxOutput[],
    destinationAddress: string,
    currentBlockHeight: number,
    feeTokensPerVirtualByte: number,
    privateKey: string,
  ): string {
    const { publicKey } = ECPair.fromWIF(
      privateKey,
      getBitcoinJSNetwork(this._network, this._subnet),
    );

    let unlock: string | undefined = undefined;
    if (isRefundPublicKeyHashRedeemScript(this.details)) {
      unlock = publicKey.toString('hex');
    }

    return this.buildTransaction(
      utxos,
      destinationAddress,
      currentBlockHeight,
      feeTokensPerVirtualByte,
      unlock,
      privateKey,
    );
  }

  /**
   * Generate the refund transaction and return the raw tx hex
   * @param utxos The unspent funding tx outputs
   * @param destinationAddress The address the funds will be refunded to
   * @param currentBlockHeight The current block height on the network
   * @param feeTokensPerVirtualByte The fee per byte (satoshi/byte)
   * @param refundSecret The admin refund secret used to offer instant refunds
   * @param privateKey The private key WIF string
   */
  public adminRefund(
    utxos: TxOutput[],
    destinationAddress: string,
    currentBlockHeight: number,
    feeTokensPerVirtualByte: number,
    refundSecret: string,
    privateKey: string,
  ): string {
    const { publicKey } = ECPair.fromWIF(
      privateKey,
      getBitcoinJSNetwork(this._network, this._subnet),
    );

    // if publicKey, only put refundSecret on stack
    let unlock: string | [string, string];
    if (isRefundPublicKeyRedeemScript(this._details)) {
      unlock = refundSecret;
    } else {
      unlock = [publicKey.toString('hex'), refundSecret];
    }

    return this.buildTransaction(
      utxos,
      destinationAddress,
      currentBlockHeight,
      feeTokensPerVirtualByte,
      unlock,
      privateKey,
      false,
    );
  }

  /**
   * Build the transaction using the provided params and return the raw tx hex
   * @param utxos The unspent funding tx outputs
   * @param destinationAddress The address the funds will be sent to
   * @param currentBlockHeight The current block height on the network
   * @param feeTokensPerVirtualByte The fee per byte (satoshi/byte)
   * @param unlock Claim secret (preimage) OR refund public key OR refund public key AND refund secret
   * @param privateKey The private key WIF string
   * @param isClaim Whether it is a claim transaction or not
   */
  private buildTransaction(
    utxos: TxOutput[],
    destinationAddress: string,
    currentBlockHeight: number,
    feeTokensPerVirtualByte: number,
    unlock: string | [string, string] | undefined,
    privateKey: string,
    isClaim?: boolean,
  ): string {
    // Create a new transaction instance
    const tx = new Transaction();

    // BIP 68 applies
    tx.version = 2;

    // Total the utxos
    const tokens = utxos.reduce((t, c) => t + Number(c.tokens), 0);

    // Add a single output containing the destination address
    tx.addOutput(
      address.toOutputScript(
        destinationAddress,
        getBitcoinJSNetwork(this._network, this._subnet),
      ),
      tokens,
    );

    tx.locktime = bip65.encode({
      blocks: currentBlockHeight,
    });

    let nSequence = 0;
    if (this._details.timelockType === UTXO.LockType.RELATIVE && !isClaim) {
      // The nSequence must be specified if a relative timelock is used and it's not a claim tx
      nSequence = this._details.timelockValue;
    }

    // Add the inputs being spent to the transaction
    this.addInputs(utxos, tx, nSequence, this.generateInputScript());

    // Estimate the tx fee
    const fee = estimateFee(
      this.redeemScript,
      utxos,
      tx.weight(),
      feeTokensPerVirtualByte,
      unlock,
    );

    // Exit early when the ratio of the amount spent on fees would be too high
    const dustRatio = 1 / 3; // Fee exceeds one third of tx value
    if (fee > tokens || fee / (tokens - fee) > dustRatio) {
      throw new Error(SwapError.FEES_TOO_HIGH);
    }

    // Reduce the final output value to give some tokens over to fees
    const [out] = tx.outs as Output[];
    out.value -= fee;

    // Set the signed witnesses
    this.addWitnessScripts(utxos, privateKey, tx, unlock);

    return tx.toHex();
  }

  /**
   * Generates the input script, which consists
   * of the prefixed redeem script buffer.
   * prefix: 22 => length; 00 => OP_0; 20 => len(sha256)
   */
  private generateInputScript(): Buffer {
    return Buffer.concat([
      Buffer.from('220020', 'hex'),
      crypto.sha256(this.redeemScriptBuffer),
    ]);
  }

  /**
   * Add the transaction inputs.
   * @param utxos The utxos we're spending
   * @param tx The tx instance
   * @param nSequence The nSequence number
   * @param inputScript The input unlock script
   */
  private addInputs(
    utxos: TxOutput[],
    tx: Transaction,
    nSequence: number,
    inputScript?: Buffer,
  ) {
    // Add Inputs
    utxos.forEach(utxo => {
      tx.addInput(
        toReversedByteOrderBuffer(utxo.txId),
        utxo.index,
        nSequence,
        inputScript,
      );
    });
  }

  /**
   * Add witness scripts. hashForWitnessV0 must be called after all inputs
   * have been added. Otherwise, you'll end up with a different sig hash.
   * @param utxos The utxos we're spending
   * @param privateKey The private key WIF string
   * @param unlock Claim secret (preimage) OR refund public key OR refund public key AND refund secret
   * @param tx The tx instance
   */
  private addWitnessScripts(
    utxos: TxOutput[],
    privateKey: string,
    tx: Transaction,
    unlock?: string | [string, string],
  ) {
    // Create the signing key from the WIF string
    const signingKey = ECPair.fromWIF(
      privateKey,
      getBitcoinJSNetwork(this._network, this._subnet),
    );

    utxos.forEach((output, i) => {
      const sigHash = tx.hashForWitnessV0(
        i,
        this.redeemScriptBuffer,
        Number(output.tokens),
        Transaction.SIGHASH_ALL,
      );
      const signature = script.signature.encode(
        signingKey.sign(sigHash),
        Transaction.SIGHASH_ALL,
      );

      const witness = [signature];

      // If admin refunding, the public key AND refund secret must be added to the stack
      if (Array.isArray(unlock)) {
        const [publicKey, refundSecret] = unlock.map(i =>
          Buffer.from(i, 'hex'),
        );
        witness.push(publicKey, refundSecret);
      } else if (unlock) {
        witness.push(Buffer.from(unlock, 'hex'));
      }

      witness.push(this.redeemScriptBuffer);
      tx.setWitness(i, witness);
    });
  }
}
