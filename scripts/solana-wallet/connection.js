import nacl from "tweetnacl";
import bs58 from "bs58";
function bytesEqual(a,b){
  if(!a||!b||a.length!==b.length)return false;
  for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;
  return true;
}
export async function confirmConnection(w,acc,isCurrent,origin){
  const sign=w.features?.["solana:signMessage"]?.signMessage;
  if(typeof sign!=="function")throw Error("This wallet cannot confirm a connection. Choose a wallet with message approval support.");
  const lib={nacl,bs58};
  if(!isCurrent())throw Error("Connection cancelled");
  const key=new Uint8Array(acc.publicKey||[]);
  if(key.length!==32||lib.bs58.encode(key)!==acc.address)throw Error("Invalid wallet account");
  const nonce=Array.from(crypto.getRandomValues(new Uint8Array(24)),x=>x.toString(16).padStart(2,"0")).join("");
  const issued=Date.now();
  const message=new TextEncoder().encode("ZAEXA wallet connection\nWebsite: "+origin+"\nWallet: "+acc.address+
    "\n\nApprove connecting this wallet to this page.\nNo transaction. No network fee. No permission to spend funds.\n\nNonce: "+nonce+"\nIssued at: "+new Date(issued).toISOString());
  const result=await w.features["solana:signMessage"].signMessage({account:acc,message});
  if(!isCurrent())throw Error("Connection cancelled");
  const out=result?.[0];
  if(!out||!bytesEqual(out.signedMessage||[],message))throw Error("Wallet did not approve this connection message");
  // Wallet Standard signMessage returns signedMessage/signature, not an account.
  // Verify against the selected account key; validate an extra account only if supplied.
  if(out.account&&(out.account.address!==acc.address||!bytesEqual(out.account.publicKey||[],key)))throw Error("Wallet account changed");
  if(out.signatureType&&out.signatureType!=="ed25519")throw Error("Unsupported connection signature");
  const signature=new Uint8Array(out.signature||[]);
  if(signature.length!==64||!lib.nacl.sign.detached.verify(message,signature,key))throw Error("Invalid connection approval signature");
  if(Date.now()-issued>300000)throw Error("Connection approval expired. Try again.");
  if(Array.isArray(w.accounts)&&!w.accounts.some(a=>a.address===acc.address&&bytesEqual(a.publicKey||[],key)))throw Error("Wallet account changed");
}
