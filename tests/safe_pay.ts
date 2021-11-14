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

    it.only('can pull back funds once they are deposited', async () => {
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


//     const [ aInstancePubkey, aInstanceBump ] = await anchor.web3.PublicKey.findProgramAddress(
//       [Buffer.from("instance"), provider.wallet.publicKey.toBuffer()], program.programId,
//     );
//     instancePubkey = aInstancePubkey;
//     instanceBump = aInstanceBump;
//     tokenMint = new anchor.web3.Keypair();
//     let providerWallet = new anchor.web3.Keypair();
//     providerWalletKey = providerWallet.publicKey;

//     // Create account
//     const lamportsForMint = await provider.connection.getMinimumBalanceForRentExemption(spl.MintLayout.span);
//     const lamportsForAccount = await provider.connection.getMinimumBalanceForRentExemption(spl.AccountLayout.span);
//     let tx = new anchor.web3.Transaction();

//     // Allocate mint
//     tx.add(
//       anchor.web3.SystemProgram.createAccount({
//         programId: spl.TOKEN_PROGRAM_ID,
//         space: spl.MintLayout.span,
//         fromPubkey: provider.wallet.publicKey,
//         newAccountPubkey: tokenMint.publicKey,
//         lamports: lamportsForMint,
//       })
//     )
//     // Allocate wallet account
//     tx.add(
//       anchor.web3.SystemProgram.createAccount({
//         programId: spl.TOKEN_PROGRAM_ID,
//         space: spl.AccountLayout.span,
//         fromPubkey: provider.wallet.publicKey,
//         newAccountPubkey: providerWallet.publicKey,
//         lamports: lamportsForAccount,
//       })
//     )

//     // Initialize mint
//     tx.add(
//       spl.Token.createInitMintInstruction(
//         spl.TOKEN_PROGRAM_ID,
//         tokenMint.publicKey,
//         6,
//         provider.wallet.publicKey,
//         provider.wallet.publicKey,
//       )
//     )
//     // Initialize wallet
//     tx.add(
//       spl.Token.createInitAccountInstruction(
//         spl.TOKEN_PROGRAM_ID,
//         tokenMint.publicKey,
//         providerWallet.publicKey,
//         provider.wallet.publicKey,
//       )
//     )
//     // Mint 1337 tokens for the account
//     tx.add(
//       spl.Token.createMintToInstruction(
//         spl.TOKEN_PROGRAM_ID,
//         tokenMint.publicKey,
//         providerWallet.publicKey,
//         provider.wallet.publicKey,
//         [],
//         1337000000,
//       )
//     )
//     await provider.send(tx, [tokenMint, providerWallet]);
//   });


//   it.only('Bar', async () => {
//     // Create a destination EOA address and fund it
//     const destination = new anchor.web3.Keypair();
//     const destinationAssociatedAccount = await spl.Token.getAssociatedTokenAddress(
//       spl.ASSOCIATED_TOKEN_PROGRAM_ID,
//       spl.TOKEN_PROGRAM_ID,
//       tokenMint.publicKey,
//       destination.publicKey,
//     );
//     const fundDestinationAddressTx = new anchor.web3.Transaction();
//     fundDestinationAddressTx.add(anchor.web3.SystemProgram.transfer({
//       fromPubkey: provider.wallet.publicKey,
//       toPubkey: destination.publicKey,
//       lamports: anchor.web3.LAMPORTS_PER_SOL,
//     }));
//     fundDestinationAddressTx.add(spl.Token.createAssociatedTokenAccountInstruction(
//       spl.ASSOCIATED_TOKEN_PROGRAM_ID,
//       spl.TOKEN_PROGRAM_ID,
//       tokenMint.publicKey,
//       destinationAssociatedAccount,
//       destination.publicKey,
//       destination.publicKey
//     ));
//     await provider.send(fundDestinationAddressTx, [destination]);

//     const amount = new anchor.BN(1334).mul(new anchor.BN(10).pow(new anchor.BN(6)));

//     // Find PDA that should correspond to the wallet for the program
//     const uid = new anchor.BN(parseInt((Date.now() / 1000).toString()));
//     const uidBuffer = uid.toBuffer('le', 8);

//     let [ statePubKey, stateBump ] = await anchor.web3.PublicKey.findProgramAddress(
//       [Buffer.from("state"), provider.wallet.publicKey.toBuffer(), destination.publicKey.toBuffer(), tokenMint.publicKey.toBuffer(), uidBuffer], program.programId,
//     );
//     let [ walletPubKey, walletBump ] = await anchor.web3.PublicKey.findProgramAddress(
//       [Buffer.from("wallet"), provider.wallet.publicKey.toBuffer(), destination.publicKey.toBuffer(), tokenMint.publicKey.toBuffer(), uidBuffer], program.programId,
//     );
//     console.log(`State pub key: ${statePubKey.toBase58()}`);
//     console.log(`Wallet Pub Key: ${walletPubKey.toBase58()}`);

//     // Initialize mint account and fund the account
//     const tx1 = await program.rpc.initializeNewGrant(uid, stateBump, walletBump, amount, {
//       accounts: {
//         applicationState: statePubKey,
//         escrowWalletState: walletPubKey,
//         mintOfTokenBeingSent: tokenMint.publicKey,
//         systemProgram: anchor.web3.SystemProgram.programId,
//         userSending: provider.wallet.publicKey,
//         userReceiving: destination.publicKey,
//         rent: anchor.web3.SYSVAR_RENT_PUBKEY,
//         tokenProgram: spl.TOKEN_PROGRAM_ID,
//         walletToWithdrawFrom: providerWalletKey,
//       },
//     });

//     // Check wallets to make sure funds moved
//     const escrowState = await readAccount(walletPubKey, provider);
//     console.log(new anchor.BN(escrowState.amount, 10, 'le').toNumber());

//     const userWalletState = await readAccount(providerWalletKey, provider);
//     console.log(new anchor.BN(userWalletState.amount, 10, 'le').toNumber());

//     // Settlement
//     const tx3 = await program.rpc.completeGrant(uid, stateBump, walletBump, {
//       signers: [destination],
//       accounts: {
//         walletToDepositTo: destinationAssociatedAccount,
//         applicationState: statePubKey,
//         escrowWalletState: walletPubKey,
//         mintOfTokenBeingSent: tokenMint.publicKey,
//         systemProgram: anchor.web3.SystemProgram.programId,
//         userSending: provider.wallet.publicKey,
//         userReceiving: destination.publicKey,
//         rent: anchor.web3.SYSVAR_RENT_PUBKEY,
//         tokenProgram: spl.TOKEN_PROGRAM_ID,
//         associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
//       },
//     });

//       // Settlement
//       // WILL NOT WORK BECUASE ESCROW IS COMPLETE
//       // const tx5 = await program.rpc.pullBack(uid, stateBump, walletBump, {
//       //   accounts: {
//       //     refundWallet: providerWalletKey,
//       //     applicationState: statePubKey,
//       //     escrowWalletState: walletPubKey,
//       //     mintOfTokenBeingSent: tokenMint.publicKey,
//       //     systemProgram: anchor.web3.SystemProgram.programId,
//       //     userSending: provider.wallet.publicKey,
//       //     userReceiving: destination.publicKey,
//       //     rent: anchor.web3.SYSVAR_RENT_PUBKEY,
//       //     tokenProgram: spl.TOKEN_PROGRAM_ID,
//       //   },
//       // });
//   });

//   // it('Is initialized!', async () => {

//   //   // Mint a new token
//   //   const tokenInfo = await readMint(tokenMint.publicKey, provider);
//   //   console.log(`Decimals is: ${tokenInfo.decimals}. Owner is ${tokenInfo.mintAuthority.toBase58()}`);


//   //   // Find PDA that should correspond to the wallet for the program
//   //   let [ walletPubkey, walletBump ] = await anchor.web3.PublicKey.findProgramAddress(
//   //     [Buffer.from("wallet"), provider.wallet.publicKey.toBuffer(), tokenMint.publicKey.toBuffer()], program.programId,
//   //   );

//   //   const tx1 = await program.rpc.initialize(instanceBump, walletBump, {
//   //     accounts: {
//   //       mint: tokenMint.publicKey,
//   //       instance: instancePubkey,
//   //       wallet: walletPubkey,
//   //       systemProgram: anchor.web3.SystemProgram.programId,
//   //       user: provider.wallet.publicKey,
//   //       rent: anchor.web3.SYSVAR_RENT_PUBKEY,
//   //       tokenProgram: spl.TOKEN_PROGRAM_ID,
//   //     },
//   //   });


//   //   // FOO
//   //   const tokenInfoLol = await provider.connection.getAccountInfo(walletPubkey);
//   //   const data = Buffer.from(tokenInfoLol.data);
//   //   const accountInfo = spl.AccountLayout.decode(data);
//   //   console.log(`Global mint: ${tokenMint.publicKey.toBase58()}`);
//   //   console.log(`Account Owner: ${new anchor.web3.PublicKey(accountInfo.owner).toBase58()}`);
//   //   console.log(`Account Mint: ${new anchor.web3.PublicKey(accountInfo.mint).toBase58()}`);


//   //   const numz = new anchor.BN(accountInfo.amount.readUInt32LE());
//   //   console.log(numz.toString());

//   //   const tokenInfo2 = await readMint(tokenMint.publicKey, provider);
//   //   console.log((tokenInfo2.supply as any as Buffer).readBigUInt64LE());

//   //   // console.log("Your transaction signature", tx1);


//   //   // const tx2 = await program.rpc.update(201, {
//   //   //   accounts: {
//   //   //     data: data.publicKey,
//   //   //     owner: provider.wallet.publicKey,
//   //   //   },
//   //   // });

//   //   // dataLayer = await program.account.data.fetch(data.publicKey);
//   //   // console.log(JSON.stringify(dataLayer));
//   // });