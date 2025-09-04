import prisma from "@/lib/db/prisma-connect";
import { findSessionsByShop } from "@/lib/db/session-storage";

const API_VERSION = "2025-07";

type CreateRoyaltyTxParams = {
  shop: string;
  orderId: string;
  description: string;
  price: number;
  currency?: string;
  royaltypercentage: number; // lowercase to match Prisma schema
  designerId: string;
};

type SessionType = {
  accessToken: string;
  shop: string;
  id: string;
  scope?: string;
  state?: string;
  isOnline?: boolean;
  expires?: string | undefined;
};

async function getActiveRoyaltySubscriptionByShop(shop: string) {
  const normalizedShop = shop.toLowerCase();
  console.log("🔍 Checking active royalty subscription for shop:", normalizedShop);

  let record = await prisma.royaltySubscription.findFirst({
    where: { shop: normalizedShop, status: "active" },
  });

  if (!record) {
    console.log("⚠️ No active subscription found, creating a new one...");
    record = await prisma.royaltySubscription.create({
      data: {
        shop: normalizedShop,
        chargeId: "unknown",
        planName: "Royalty Usage Plan",
        status: "active",
        test: true,
      },
    });
    console.log("✅ Created new active subscription:", record);
  } else {
    console.log("✅ Found active subscription:", record);
  }

  return record;
}

export async function createRoyaltyTransactionForOrder({
  shop,
  orderId,
  description,
  price,
  currency = "USD",
  royaltypercentage,
  designerId,
}: CreateRoyaltyTxParams) {
  console.log("📝 Creating royalty transaction for order:", orderId);
  console.log("Shop:", shop, "Description:", description, "Price:", price);

  const subscriptionRecord = await getActiveRoyaltySubscriptionByShop(shop);
  const chargeId = subscriptionRecord?.chargeId;
  console.log("Charge ID to use:", chargeId);

  if (!chargeId) throw new Error("No active chargeId found for this shop");

  const sessions = (await findSessionsByShop(shop)) as SessionType[] | SessionType | null;
  const token = Array.isArray(sessions) ? sessions[0]?.accessToken : sessions?.accessToken;
  console.log("Access token found:", !!token);

  if (!token) throw new Error("No access token found for this shop");

  console.log("🔗 Sending usage charge request to Shopify API...");
  const resp = await fetch(
    `https://${shop}/admin/api/${API_VERSION}/recurring_application_charges/${chargeId}/usage_charges.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ usage_charge: { description, price } }),
    }
  );

  const data = await resp.json();
  console.log("Shopify API response:", data);

  if (!resp.ok) {
    console.error("❌ Failed to create usage charge:", data);
    throw new Error(`Failed to create usage charge: ${JSON.stringify(data)}`);
  }

  const usageChargeData = data?.usage_charge;
  if (!usageChargeData) throw new Error("No usage charge data returned");

  console.log("✅ Usage charge created successfully:", usageChargeData.id);

  // ✅ Prisma create matches the schema exactly
  const royaltyTransaction = await prisma.royaltyTransaction.create({
    data: {
      shop,
      shopifyTransactionChargeId: usageChargeData.id.toString(),
      orderId,
      description: usageChargeData.description,
      price: parseFloat(usageChargeData.price),
      currency: usageChargeData.currency,
      balanceUsed: parseFloat(usageChargeData.balance_used),
      balanceRemaining: parseFloat(usageChargeData.balance_remaining),
      royaltypercentage,
      designerId,
      createdAt: new Date(usageChargeData.created_at),
    },
  });

  console.log("✅ Royalty transaction saved in DB:", royaltyTransaction.id);
  return royaltyTransaction;
}
