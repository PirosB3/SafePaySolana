import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import * as spl from '@solana/spl-token';
import { SafePay } from '../target/types/safe_pay';

describe('safe_pay', () => {

  // Configure the client to use the local cluster.
  const provider = anchor.Provider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SafePay as Program<SafePay>;

  let tokenMint: anchor.web3.Keypair;
  let providerWalletKey: anchor.web3.PublicKey;
  let instancePubkey: anchor.web3.PublicKey;
  let instanceBump: number 

  beforeEach(async () => {
    const [ aInstancePubkey, aInstanceBump ] = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from("instance"), provider.wallet.publicKey.toBuffer()], program.programId,
    );
    instancePubkey = aInstancePubkey;
    instanceBump = aInstanceBump;
    tokenMint = new anchor.web3.Keypair();
    let providerWallet = new anchor.web3.Keypair();
    providerWalletKey = providerWallet.publicKey;
    
    // Create account
    const lamportsForMint = await provider.connection.getMinimumBalanceForRentExemption(spl.MintLayout.span);
    const lamportsForAccount = await provider.connection.getMinimumBalanceForRentExemption(spl.AccountLayout.span);
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
      anchor.web3.SystemProgram.createAccount({
        programId: spl.TOKEN_PROGRAM_ID,
        space: spl.AccountLayout.span,
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: providerWallet.publicKey,
        lamports: lamportsForAccount,
      })
    )

    // Initialize mint
    tx.add(
      spl.Token.createInitMintInstruction(
        spl.TOKEN_PROGRAM_ID,
        tokenMint.publicKey,
        6,
        provider.wallet.publicKey,
        provider.wallet.publicKey,
      )
    )
    // Initialize wallet
    tx.add(
      spl.Token.createInitAccountInstruction(
        spl.TOKEN_PROGRAM_ID,
        tokenMint.publicKey,
        providerWallet.publicKey,
        provider.wallet.publicKey,
      )
    )
    // Mint 1337 tokens for the account
    tx.add(
      spl.Token.createMintToInstruction(
        spl.TOKEN_PROGRAM_ID,
        tokenMint.publicKey,
        providerWallet.publicKey,
        provider.wallet.publicKey,
        [],
        1337000000,
      )
    )
    await provider.send(tx, [tokenMint, providerWallet]);
  });

  const readAccount = async (accountPublicKey: anchor.web3.PublicKey, provider: anchor.Provider): Promise<AccountInfo> => {
    const tokenInfoLol = await provider.connection.getAccountInfo(accountPublicKey);
    const data = Buffer.from(tokenInfoLol.data);
    const accountInfo: AccountInfo = spl.AccountLayout.decode(data);
    return accountInfo;
  }

  const readMint = async (mintPublicKey: anchor.web3.PublicKey, provider: anchor.Provider) : Promise<spl.MintInfo> => {
    const tokenInfo = await provider.connection.getAccountInfo(mintPublicKey);
    const data = Buffer.from(tokenInfo.data);
    const accountInfo = spl.MintLayout.decode(data);
    return {
      ...accountInfo,
      mintAuthority: accountInfo.mintAuthority == null ? null : anchor.web3.PublicKey.decode(accountInfo.mintAuthority),
      freezeAuthority: accountInfo.freezeAuthority == null ? null : anchor.web3.PublicKey.decode(accountInfo.freezeAuthority),
    }
  }

  it.only('Bar', async () => {
    // Create a destination EOA address and fund it
    const destination = new anchor.web3.Keypair();
    const destinationAssociatedAccount = await spl.Token.getAssociatedTokenAddress(
      spl.ASSOCIATED_TOKEN_PROGRAM_ID,
      spl.TOKEN_PROGRAM_ID,
      tokenMint.publicKey,
      destination.publicKey,
    );
    const fundDestinationAddressTx = new anchor.web3.Transaction();
    fundDestinationAddressTx.add(anchor.web3.SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: destination.publicKey,
      lamports: anchor.web3.LAMPORTS_PER_SOL,
    }));
    fundDestinationAddressTx.add(spl.Token.createAssociatedTokenAccountInstruction(
      spl.ASSOCIATED_TOKEN_PROGRAM_ID,
      spl.TOKEN_PROGRAM_ID,
      tokenMint.publicKey,
      destinationAssociatedAccount,
      destination.publicKey,
      destination.publicKey
    ));
    await provider.send(fundDestinationAddressTx, [destination]);

    const amount = new anchor.BN(1334).mul(new anchor.BN(10).pow(new anchor.BN(6)));

    // Find PDA that should correspond to the wallet for the program
    const uid = new anchor.BN(parseInt((Date.now() / 1000).toString()));
    const uidBuffer = uid.toBuffer('le', 8);
    
    let [ statePubKey, stateBump ] = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from("state"), provider.wallet.publicKey.toBuffer(), destination.publicKey.toBuffer(), tokenMint.publicKey.toBuffer(), uidBuffer], program.programId,
    );
    let [ walletPubKey, walletBump ] = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from("wallet"), provider.wallet.publicKey.toBuffer(), destination.publicKey.toBuffer(), tokenMint.publicKey.toBuffer(), uidBuffer], program.programId,
    );
    console.log(`State pub key: ${statePubKey.toBase58()}`);
    console.log(`Wallet Pub Key: ${walletPubKey.toBase58()}`);
  
    // Initialize mint account and fund the account
    const tx1 = await program.rpc.initializeNewGrant(uid, stateBump, walletBump, amount, {
      accounts: {
        applicationState: statePubKey,
        escrowWalletState: walletPubKey,
        mintOfTokenBeingSent: tokenMint.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        userSending: provider.wallet.publicKey,
        userReceiving: destination.publicKey,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: spl.TOKEN_PROGRAM_ID,
        walletToWithdrawFrom: providerWalletKey,
      },
    });

    // Check wallets to make sure funds moved
    const escrowState = await readAccount(walletPubKey, provider);
    console.log(new anchor.BN(escrowState.amount, 10, 'le').toNumber());

    const userWalletState = await readAccount(providerWalletKey, provider);
    console.log(new anchor.BN(userWalletState.amount, 10, 'le').toNumber());

    // Settlement
    const tx3 = await program.rpc.completeGrant(uid, stateBump, walletBump, {
      signers: [destination],
      accounts: {
        walletToDepositTo: destinationAssociatedAccount,
        applicationState: statePubKey,
        escrowWalletState: walletPubKey,
        mintOfTokenBeingSent: tokenMint.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        userSending: provider.wallet.publicKey,
        userReceiving: destination.publicKey,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: spl.TOKEN_PROGRAM_ID,
        associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
      },
    });
  
      // Settlement
      // WILL NOT WORK BECUASE ESCROW IS COMPLETE
      // const tx5 = await program.rpc.pullBack(uid, stateBump, walletBump, {
      //   accounts: {
      //     refundWallet: providerWalletKey,
      //     applicationState: statePubKey,
      //     escrowWalletState: walletPubKey,
      //     mintOfTokenBeingSent: tokenMint.publicKey,
      //     systemProgram: anchor.web3.SystemProgram.programId,
      //     userSending: provider.wallet.publicKey,
      //     userReceiving: destination.publicKey,
      //     rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      //     tokenProgram: spl.TOKEN_PROGRAM_ID,
      //   },
      // });
  });

  // it('Is initialized!', async () => {

  //   // Mint a new token
  //   const tokenInfo = await readMint(tokenMint.publicKey, provider);
  //   console.log(`Decimals is: ${tokenInfo.decimals}. Owner is ${tokenInfo.mintAuthority.toBase58()}`);


  //   // Find PDA that should correspond to the wallet for the program
  //   let [ walletPubkey, walletBump ] = await anchor.web3.PublicKey.findProgramAddress(
  //     [Buffer.from("wallet"), provider.wallet.publicKey.toBuffer(), tokenMint.publicKey.toBuffer()], program.programId,
  //   );

  //   const tx1 = await program.rpc.initialize(instanceBump, walletBump, {
  //     accounts: {
  //       mint: tokenMint.publicKey,
  //       instance: instancePubkey,
  //       wallet: walletPubkey,
  //       systemProgram: anchor.web3.SystemProgram.programId,
  //       user: provider.wallet.publicKey,
  //       rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  //       tokenProgram: spl.TOKEN_PROGRAM_ID,
  //     },
  //   });


  //   // FOO
  //   const tokenInfoLol = await provider.connection.getAccountInfo(walletPubkey);
  //   const data = Buffer.from(tokenInfoLol.data);
  //   const accountInfo = spl.AccountLayout.decode(data);
  //   console.log(`Global mint: ${tokenMint.publicKey.toBase58()}`);
  //   console.log(`Account Owner: ${new anchor.web3.PublicKey(accountInfo.owner).toBase58()}`);
  //   console.log(`Account Mint: ${new anchor.web3.PublicKey(accountInfo.mint).toBase58()}`);


  //   const numz = new anchor.BN(accountInfo.amount.readUInt32LE());
  //   console.log(numz.toString());

  //   const tokenInfo2 = await readMint(tokenMint.publicKey, provider);
  //   console.log((tokenInfo2.supply as any as Buffer).readBigUInt64LE());

  //   // console.log("Your transaction signature", tx1);


  //   // const tx2 = await program.rpc.update(201, {
  //   //   accounts: {
  //   //     data: data.publicKey,
  //   //     owner: provider.wallet.publicKey,
  //   //   },
  //   // });

  //   // dataLayer = await program.account.data.fetch(data.publicKey);
  //   // console.log(JSON.stringify(dataLayer));
  // });
});
