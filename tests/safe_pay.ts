import assert from "assert";
import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import * as spl from '@solana/spl-token';
import { SafePay } from '../target/types/safe_pay';

interface PDAParameters {
    escrowWalletKey: anchor.web3.PublicKey,
    stateKey: anchor.web3.PublicKey,
    escrowBump: number,
    stateBump: number,
    idx: anchor.BN,
}

describe('safe_pay', () => {

    // Configure the client to use the local cluster.
    const provider = anchor.Provider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.SafePay as Program<SafePay>;

    let mintAddress: anchor.web3.PublicKey;
    let alice: anchor.web3.Keypair;
    let aliceWallet: anchor.web3.PublicKey;
    let bob: anchor.web3.Keypair;

    let pda: PDAParameters;

    const getPdaParams = async (connection: anchor.web3.Connection, alice: anchor.web3.PublicKey, bob: anchor.web3.PublicKey, mint: anchor.web3.PublicKey): Promise<PDAParameters> => {
        const uid = new anchor.BN(parseInt((Date.now() / 1000).toString()));
        const uidBuffer = uid.toBuffer('le', 8);

        let [statePubKey, stateBump] = await anchor.web3.PublicKey.findProgramAddress(
            [Buffer.from("state"), alice.toBuffer(), bob.toBuffer(), mint.toBuffer(), uidBuffer], program.programId,
        );
        let [walletPubKey, walletBump] = await anchor.web3.PublicKey.findProgramAddress(
            [Buffer.from("wallet"), alice.toBuffer(), bob.toBuffer(), mint.toBuffer(), uidBuffer], program.programId,
        );
        return {
            idx: uid,
            escrowBump: walletBump,
            escrowWalletKey: walletPubKey,
            stateBump,
            stateKey: statePubKey,
        }
    }

    const createMint = async (connection: anchor.web3.Connection): Promise<anchor.web3.PublicKey> => {
        const tokenMint = new anchor.web3.Keypair();
        const lamportsForMint = await provider.connection.getMinimumBalanceForRentExemption(spl.MintLayout.span);
        let tx = new anchor.web3.Transaction();

        // Allocate mint
        tx.add(
            anchor.web3.SystemProgram.createAccount({
                programId: spl.TOKEN_PROGRAM_ID,
                space: spl.MintLayout.span,
                fromPubkey: provider.wallet.publicKey,
                newAccountPubkey: tokenMint.publicKey,
                lamports: lamportsForMint,
            })
        )
        // Allocate wallet account
        tx.add(
            spl.Token.createInitMintInstruction(
                spl.TOKEN_PROGRAM_ID,
                tokenMint.publicKey,
                6,
                provider.wallet.publicKey,
                provider.wallet.publicKey,
            )
        );
        const signature = await provider.send(tx, [tokenMint]);

        console.log(`[${tokenMint.publicKey}] Created new mint account at ${signature}`);
        return tokenMint.publicKey;
    }

    const createUserAndAssociatedWallet = async (connection: anchor.web3.Connection, mint?: anchor.web3.PublicKey): Promise<[anchor.web3.Keypair, anchor.web3.PublicKey | undefined]> => {
        const user = new anchor.web3.Keypair();
        let userAssociatedTokenAccount: anchor.web3.PublicKey | undefined = undefined;

        // Fund user with some SOL
        let txFund = new anchor.web3.Transaction();
        txFund.add(anchor.web3.SystemProgram.transfer({
            fromPubkey: provider.wallet.publicKey,
            toPubkey: user.publicKey,
            lamports: 5 * anchor.web3.LAMPORTS_PER_SOL,
        }));
        const sigTxFund = await provider.send(txFund);
        console.log(`[${user.publicKey.toBase58()}] Funded new account with 5 SOL: ${sigTxFund}`);

        if (mint) {
            // Create a token account for the user and mint some tokens
            userAssociatedTokenAccount = await spl.Token.getAssociatedTokenAddress(
                spl.ASSOCIATED_TOKEN_PROGRAM_ID,
                spl.TOKEN_PROGRAM_ID,
                mint,
                user.publicKey
            )

            const txFundTokenAccount = new anchor.web3.Transaction();
            txFundTokenAccount.add(spl.Token.createAssociatedTokenAccountInstruction(
                spl.ASSOCIATED_TOKEN_PROGRAM_ID,
                spl.TOKEN_PROGRAM_ID,
                mint,
                userAssociatedTokenAccount,
                user.publicKey,
                user.publicKey,
            ))
            txFundTokenAccount.add(spl.Token.createMintToInstruction(
                spl.TOKEN_PROGRAM_ID,
                mint,
                userAssociatedTokenAccount,
                provider.wallet.publicKey,
                [],
                1337000000,
            ));
            const txFundTokenSig = await provider.send(txFundTokenAccount, [user]);
            console.log(`[${userAssociatedTokenAccount.toBase58()}] New associated account for mint ${mint.toBase58()}: ${txFundTokenSig}`);
        }
        return [user, userAssociatedTokenAccount];
    }

    const readAccount = async (accountPublicKey: anchor.web3.PublicKey, provider: anchor.Provider): Promise<[spl.AccountInfo, string]> => {
        const tokenInfoLol = await provider.connection.getAccountInfo(accountPublicKey);
        const data = Buffer.from(tokenInfoLol.data);
        const accountInfo: spl.AccountInfo = spl.AccountLayout.decode(data);

        const amount = (accountInfo.amount as any as Buffer).readBigUInt64LE();
        return [accountInfo, amount.toString()];
    }

    const readMint = async (mintPublicKey: anchor.web3.PublicKey, provider: anchor.Provider): Promise<spl.MintInfo> => {
        const tokenInfo = await provider.connection.getAccountInfo(mintPublicKey);
        const data = Buffer.from(tokenInfo.data);
        const accountInfo = spl.MintLayout.decode(data);
        return {
            ...accountInfo,
            mintAuthority: accountInfo.mintAuthority == null ? null : anchor.web3.PublicKey.decode(accountInfo.mintAuthority),
            freezeAuthority: accountInfo.freezeAuthority == null ? null : anchor.web3.PublicKey.decode(accountInfo.freezeAuthority),
        }
    }

    beforeEach(async () => {
        mintAddress = await createMint(provider.connection);
        [alice, aliceWallet] = await createUserAndAssociatedWallet(provider.connection, mintAddress);

        let _rest;
        [bob, ..._rest] = await createUserAndAssociatedWallet(provider.connection);

        pda = await getPdaParams(provider.connection, alice.publicKey, bob.publicKey, mintAddress);
    });

    it('can initialize a safe payment by Alice', async () => {
        const [, aliceBalancePre] = await readAccount(aliceWallet, provider);
        assert.equal(aliceBalancePre, '1337000000');

        const amount = new anchor.BN(20000000);

        // Initialize mint account and fund the account
        const tx1 = await program.rpc.initializeNewGrant(pda.idx, pda.stateBump, pda.escrowBump, amount, {
            accounts: {
                applicationState: pda.stateKey,
                escrowWalletState: pda.escrowWalletKey,
                mintOfTokenBeingSent: mintAddress,
                userSending: alice.publicKey,
                userReceiving: bob.publicKey,
                walletToWithdrawFrom: aliceWallet,

                systemProgram: anchor.web3.SystemProgram.programId,
                rent: anchor.web3.SYSVAR_RENT_PUBKEY,
                tokenProgram: spl.TOKEN_PROGRAM_ID,
            },
            signers: [alice],
        });
        console.log(`Initialized a new Safe Pay instance. Alice will pay bob 20 tokens`);

        // Assert that 20 tokens were moved from Alice's account to the escrow.
        const [, aliceBalancePost] = await readAccount(aliceWallet, provider);
        assert.equal(aliceBalancePost, '1317000000');
        const [, escrowBalancePost] = await readAccount(pda.escrowWalletKey, provider);
        assert.equal(escrowBalancePost, '20000000');

        const state = await program.account.state.fetch(pda.stateKey);
        assert.equal(state.amountTokens.toString(), '20000000');
        assert.equal(state.stage.toString(), '1');
    })

    it('can send escrow funds to Bob', async () => {
        const [, aliceBalancePre] = await readAccount(aliceWallet, provider);
        assert.equal(aliceBalancePre, '1337000000');

        const amount = new anchor.BN(20000000);

        // Initialize mint account and fund the account
        const tx1 = await program.rpc.initializeNewGrant(pda.idx, pda.stateBump, pda.escrowBump, amount, {
            accounts: {
                applicationState: pda.stateKey,
                escrowWalletState: pda.escrowWalletKey,
                mintOfTokenBeingSent: mintAddress,
                userSending: alice.publicKey,
                userReceiving: bob.publicKey,
                walletToWithdrawFrom: aliceWallet,

                systemProgram: anchor.web3.SystemProgram.programId,
                rent: anchor.web3.SYSVAR_RENT_PUBKEY,
                tokenProgram: spl.TOKEN_PROGRAM_ID,
            },
            signers: [alice],
        });
        console.log(`Initialized a new Safe Pay instance. Alice will pay bob 20 tokens`);

        // Assert that 20 tokens were moved from Alice's account to the escrow.
        const [, aliceBalancePost] = await readAccount(aliceWallet, provider);
        assert.equal(aliceBalancePost, '1317000000');
        const [, escrowBalancePost] = await readAccount(pda.escrowWalletKey, provider);
        assert.equal(escrowBalancePost, '20000000');

        // Create a token account for Bob.
        const bobTokenAccount = await spl.Token.getAssociatedTokenAddress(
            spl.ASSOCIATED_TOKEN_PROGRAM_ID,
            spl.TOKEN_PROGRAM_ID,
            mintAddress,
            bob.publicKey
        )
        const tx2 = await program.rpc.completeGrant(pda.idx, pda.stateBump, pda.escrowBump, {
            accounts: {
                applicationState: pda.stateKey,
                escrowWalletState: pda.escrowWalletKey,
                mintOfTokenBeingSent: mintAddress,
                userSending: alice.publicKey,
                userReceiving: bob.publicKey,
                walletToDepositTo: bobTokenAccount,

                systemProgram: anchor.web3.SystemProgram.programId,
                rent: anchor.web3.SYSVAR_RENT_PUBKEY,
                tokenProgram: spl.TOKEN_PROGRAM_ID,
                associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
            },
            signers: [bob],
        });

        // Assert that 20 tokens were sent back.
        const [, bobBalance] = await readAccount(bobTokenAccount, provider);
        assert.equal(bobBalance, '20000000');

        // // Assert that escrow was correctly closed.
        try {
            await readAccount(pda.escrowWalletKey, provider);
            return assert.fail("Account should be closed");
        } catch (e) {
            assert.equal(e.message, "Cannot read properties of null (reading 'data')");
        }
    })

    it('can pull back funds once they are deposited', async () => {
        const [, aliceBalancePre] = await readAccount(aliceWallet, provider);
        assert.equal(aliceBalancePre, '1337000000');

        const amount = new anchor.BN(20000000);

        // Initialize mint account and fund the account
        const tx1 = await program.rpc.initializeNewGrant(pda.idx, pda.stateBump, pda.escrowBump, amount, {
            accounts: {
                applicationState: pda.stateKey,
                escrowWalletState: pda.escrowWalletKey,
                mintOfTokenBeingSent: mintAddress,
                userSending: alice.publicKey,
                userReceiving: bob.publicKey,
                walletToWithdrawFrom: aliceWallet,

                systemProgram: anchor.web3.SystemProgram.programId,
                rent: anchor.web3.SYSVAR_RENT_PUBKEY,
                tokenProgram: spl.TOKEN_PROGRAM_ID,
            },
            signers: [alice],
        });
        console.log(`Initialized a new Safe Pay instance. Alice will pay bob 20 tokens`);

        // Assert that 20 tokens were moved from Alice's account to the escrow.
        const [, aliceBalancePost] = await readAccount(aliceWallet, provider);
        assert.equal(aliceBalancePost, '1317000000');
        const [, escrowBalancePost] = await readAccount(pda.escrowWalletKey, provider);
        assert.equal(escrowBalancePost, '20000000');

        // Withdraw the funds back
        const tx2 = await program.rpc.pullBack(pda.idx, pda.stateBump, pda.escrowBump, {
            accounts: {
                applicationState: pda.stateKey,
                escrowWalletState: pda.escrowWalletKey,
                mintOfTokenBeingSent: mintAddress,
                userSending: alice.publicKey,
                userReceiving: bob.publicKey,
                refundWallet: aliceWallet,

                systemProgram: anchor.web3.SystemProgram.programId,
                rent: anchor.web3.SYSVAR_RENT_PUBKEY,
                tokenProgram: spl.TOKEN_PROGRAM_ID,
            },
            signers: [alice],
        });

        // Assert that 20 tokens were sent back.
        const [, aliceBalanceRefund] = await readAccount(aliceWallet, provider);
        assert.equal(aliceBalanceRefund, '1337000000');

        // Assert that escrow was correctly closed.
        try {
            await readAccount(pda.escrowWalletKey, provider);
            return assert.fail("Account should be closed");
        } catch (e) {
            assert.equal(e.message, "Cannot read properties of null (reading 'data')");
        }

        const state = await program.account.state.fetch(pda.stateKey);
        assert.equal(state.amountTokens.toString(), '20000000');
        assert.equal(state.stage.toString(), '3');

    })

});