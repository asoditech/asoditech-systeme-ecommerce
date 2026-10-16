"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, Search, ShieldAlert, AlertTriangle, Check, Warehouse, X, UserRound } from "lucide-react";
import {
  createOrderAction,
  createCustomerForOrderAction,
  getOrderLinesStockAction,
  searchCustomersForOrderAction,
  searchProductsForOrderAction,
  type PickerStock,
} from "@/actions/orders";
import { StockOverrideDialog } from "@/components/orders/stock-override-dialog";
import { stockShortageOf, type StockShortage } from "@/lib/stock-shortage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BarcodeScanButton } from "@/components/barcode-scanner/barcode-scan-button";
import { LOOKUP_SCAN_FORMATS } from "@/lib/barcode-scanner/support";
import { CityInput } from "@/components/delivery/city-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldHint, FieldRow } from "@/components/ui/field";
import { FormActions, FormSection, FormSectionGroup } from "@/components/form-section";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/format";
import { PAYMENT_METHOD_LABELS, WAREHOUSE_TYPE_LABELS, ORDER_CHANNEL_LABELS } from "@/lib/status-labels";
import { cityGuidanceMessage, type CityGuidance } from "@/lib/integrations/delivery/city-guidance";
import { applyShippingPrefill, customerShippingDefaults, type ShippingFields } from "@/lib/orders/shipping-prefill";
import { SelectedLineChips } from "@/components/orders/selected-line-chips";
import { useListboxNavigation } from "@/components/ui/use-listbox-navigation";
import type { Customer } from "@prisma/client";
import { Notice } from "@/components/ui/notice";

interface SelectableWarehouse {
  id: string;
  name: string;
  type: "ENTREPOT" | "MAGASIN";
  isDefault: boolean;
}

type ProductWithVariations = Awaited<ReturnType<typeof searchProductsForOrderAction>>[number];
type CustomerSearchResult = Awaited<ReturnType<typeof searchCustomersForOrderAction>>[number];
type ProductVariation = ProductWithVariations["variations"][number];

interface LineItem {
  key: string;
  productId?: string;
  variationId?: string;
  /** The parent product — only to look up stock (P2); never sent with the order. */
  stockProductId: string;
  label: string;
  sku: string;
  unitPrice: number;
  quantity: number;
  discount: number;
}

export function OrderForm({
  warehouses = [],
  commissionAgents = [],
  canConfirm = false,
  cityGuidance = { tone: "none" },
}: {
  warehouses?: SelectableWarehouse[];
  commissionAgents?: { id: string; name: string }[];
  /** `orders.confirm` — offers « Client déjà confirmé » (docs/adr/0046); re-checked server-side. */
  canConfirm?: boolean;
  /** Which delivery provider (if any) the city field's warning should name — never hard-coded (docs/adr/0018). */
  cityGuidance?: CityGuidance;
}) {
  const router = useRouter();
  const defaultWarehouseId = warehouses.find((w) => w.isDefault)?.id ?? warehouses[0]?.id ?? "";
  const [confirmationAgentId, setConfirmationAgentId] = React.useState("");
  const [fulfillmentWarehouseId, setFulfillmentWarehouseId] = React.useState(defaultWarehouseId);
  // P2: the warehouse whose stock is shown — the SAME rule the order uses when
  // created (one warehouse = the server-side default), so the badge, the
  // confirmation check and the override token all talk about the same rows.
  const stockWarehouseId = warehouses.length > 1 && fulfillmentWarehouseId ? fulfillmentWarehouseId : null;
  const [lineStock, setLineStock] = React.useState<Record<string, PickerStock>>({});
  // Stale-response guard (P2): the warehouse whose stock may be displayed NOW,
  // updated synchronously on change, plus a sequence for line-stock refreshes.
  // A response is applied only if it was requested for the current warehouse
  // (and, for lines, is the latest request) — a slow answer for a warehouse the
  // user already left can never overwrite the shown stock.
  const currentStockWarehouse = React.useRef<string | null>(stockWarehouseId);
  const lineStockRequest = React.useRef(0);
  const [shortage, setShortage] = React.useState<StockShortage | null>(null);
  const [customer, setCustomer] = React.useState<Customer | null>(null);
  const [customerQuery, setCustomerQuery] = React.useState("");
  const [customerResults, setCustomerResults] = React.useState<CustomerSearchResult[]>([]);
  const [customerOpen, setCustomerOpen] = React.useState(false);
  // Inline "create a new client" panel inside the customer popover.
  const [newCustomerMode, setNewCustomerMode] = React.useState(false);
  const [newCustName, setNewCustName] = React.useState("");
  const [newCustPhone, setNewCustPhone] = React.useState("");
  const [newCustCity, setNewCustCity] = React.useState("");
  const [newCustAddress, setNewCustAddress] = React.useState("");
  const [savingCustomer, setSavingCustomer] = React.useState(false);

  const [productQuery, setProductQuery] = React.useState("");
  const [productResults, setProductResults] = React.useState<ProductWithVariations[]>([]);
  const [productOpen, setProductOpen] = React.useState(false);

  const [items, setItems] = React.useState<LineItem[]>([]);
  const [paymentMethod, setPaymentMethod] = React.useState("PAIEMENT_LIVRAISON");
  const [channel, setChannel] = React.useState("WHATSAPP");
  const [customerAlreadyConfirmed, setCustomerAlreadyConfirmed] = React.useState(false);
  const [shippingCost, setShippingCost] = React.useState("0");
  const [discountTotal, setDiscountTotal] = React.useState("0");
  const [notes, setNotes] = React.useState("");
  const [shippingCity, setShippingCity] = React.useState("");
  const [shippingAddress, setShippingAddress] = React.useState("");
  const [shippingPhone, setShippingPhone] = React.useState("");
  const [isPending, startTransition] = React.useTransition();

  // "Searching" is derived, not stored: true whenever the query is long
  // enough but its results haven't landed yet — never set synchronously
  // from the effect body (only from the debounced callback once results
  // are in), so there's no render-triggers-effect-triggers-render loop.
  const [customerSearchedFor, setCustomerSearchedFor] = React.useState("");
  const [productSearchedFor, setProductSearchedFor] = React.useState("");
  const customerSearching = customerQuery.trim().length >= 2 && customerSearchedFor !== customerQuery.trim();
  const productSearching = productQuery.trim().length >= 2 && productSearchedFor !== productQuery.trim();

  const [customerSearchError, setCustomerSearchError] = React.useState(false);
  React.useEffect(() => {
    if (customerQuery.trim().length < 2) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const q = customerQuery.trim();
      try {
        const results = await searchCustomersForOrderAction(customerQuery);
        if (cancelled) return;
        setCustomerResults(results);
        setCustomerSearchError(false);
      } catch {
        if (cancelled) return;
        setCustomerResults([]);
        setCustomerSearchError(true);
      }
      setCustomerSearchedFor(q);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [customerQuery]);
  // Initial list on open with an empty query: the most recent customers this
  // user may see (same tenant + visibility rule as the search), fetched once
  // on first open — never on page load.
  const [initialCustomers, setInitialCustomers] = React.useState<CustomerSearchResult[] | null>(null);
  const [initialCustomersLoading, setInitialCustomersLoading] = React.useState(false);
  function openCustomerPicker(open: boolean) {
    setCustomerOpen(open);
    if (!open) {
      setNewCustomerMode(false);
      return;
    }
    if (initialCustomers !== null || initialCustomersLoading) return;
    setInitialCustomersLoading(true);
    searchCustomersForOrderAction("")
      .then((list) => {
        setInitialCustomers(list);
        setCustomerSearchError(false);
      })
      .catch(() => {
        setInitialCustomers([]);
        setCustomerSearchError(true);
      })
      .finally(() => setInitialCustomersLoading(false));
  }
  const customerQueryEmpty = customerQuery.trim().length === 0;
  // Query too short for a server round-trip — don't show stale results from a longer query.
  const visibleCustomerResults =
    customerQuery.trim().length >= 2 ? customerResults : customerQueryEmpty ? (initialCustomers ?? []) : [];

  React.useEffect(() => {
    if (productQuery.trim().length < 2) return;
    let cancelled = false; // a newer query or warehouse supersedes this one
    const t = setTimeout(async () => {
      const q = productQuery.trim();
      const results = await searchProductsForOrderAction(productQuery, stockWarehouseId);
      if (cancelled || currentStockWarehouse.current !== stockWarehouseId) return;
      setProductResults(results);
      setProductSearchedFor(q);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [productQuery, stockWarehouseId]);
  // Initial list shown when the picker is opened with an empty query: the
  // first active products by name, fetched once on first open (never on page
  // load). Typing 2+ characters switches to the normal search below.
  const [initialProducts, setInitialProducts] = React.useState<ProductWithVariations[] | null>(null);
  const [initialProductsLoading, setInitialProductsLoading] = React.useState(false);
  function openProductPicker(open: boolean) {
    setProductOpen(open);
    if (!open || initialProducts !== null || initialProductsLoading) return;
    setInitialProductsLoading(true);
    const requestedFor = stockWarehouseId;
    searchProductsForOrderAction("", requestedFor)
      .then((list) => {
        if (currentStockWarehouse.current === requestedFor) setInitialProducts(list);
      })
      .catch(() => {
        if (currentStockWarehouse.current === requestedFor) setInitialProducts([]);
      })
      .finally(() => setInitialProductsLoading(false));
  }
  const productQueryEmpty = productQuery.trim().length === 0;
  const visibleProductResults =
    productQuery.trim().length >= 2 ? productResults : productQueryEmpty ? (initialProducts ?? []) : [];

  /** P2: the fulfilment warehouse changed — every stock shown must follow it. */
  function changeFulfillmentWarehouse(id: string) {
    setFulfillmentWarehouseId(id);
    setInitialProducts(null); // re-fetched for the new warehouse on next open
    const nextStockWarehouseId = warehouses.length > 1 && id ? id : null;
    currentStockWarehouse.current = nextStockWarehouseId;
    const seq = ++lineStockRequest.current;
    if (items.length === 0) return;
    const requested = items.map((i) => ({ productId: i.stockProductId, variationId: i.variationId ?? null }));
    const isLatest = () => seq === lineStockRequest.current && currentStockWarehouse.current === nextStockWarehouseId;
    getOrderLinesStockAction(nextStockWarehouseId, requested)
      // merge: lines added meanwhile keep the stock their own (current) search gave them
      .then((fresh) => {
        if (isLatest()) setLineStock((prev) => ({ ...prev, ...fresh }));
      })
      .catch(() => {
        // never keep showing the previous warehouse's numbers for these lines
        if (!isLatest()) return;
        setLineStock((prev) => {
          const next = { ...prev };
          for (const u of requested) delete next[stockKey(u.productId, u.variationId)];
          return next;
        });
      });
  }

  function addProductLine(product: ProductWithVariations, variation?: ProductVariation) {
    setLineStock((prev) => ({ ...prev, [stockKey(product.id, variation?.id)]: variation ? variation.stock : product.stock }));
    setItems((prev) => [
      ...prev,
      {
        key: `${product.id}-${variation?.id ?? "base"}-${Date.now()}`,
        productId: variation ? undefined : product.id,
        variationId: variation?.id,
        stockProductId: product.id,
        label: variation ? `${product.name} (${Object.values(variation.attributes as Record<string, string>).join(", ")})` : product.name,
        sku: variation?.sku ?? product.sku,
        // Batch 4: variation.salePrice is a new top tier on this screen's
        // existing (product.salePrice-less) chain — still just a prefill,
        // never enforced server-side (order pricing stays operator-editable
        // by design, unlike Sale/POS — see createOrderAction).
        unitPrice: Number(variation?.salePrice ?? variation?.price ?? product.price),
        quantity: 1,
        discount: 0,
      },
    ]);
    // The picker stays open with its results: select product 1, 2, 3… in a
    // row; each one is added as its own line, exactly as before.
  }

  const isUnitInOrder = (productId: string, variationId?: string) =>
    items.some((i) => (variationId ? i.variationId === variationId : i.productId === productId && !i.variationId));

  // Selected customer → THIS order's delivery fields (editable, never written
  // back to the customer; a value typed by hand is kept — see shipping-prefill).
  const lastShippingPrefill = React.useRef<ShippingFields>({ address: "", city: "", phone: "" });
  function prefillShipping(source: Parameters<typeof customerShippingDefaults>[0]) {
    const defaults = customerShippingDefaults(source);
    const next = applyShippingPrefill(
      { address: shippingAddress, city: shippingCity, phone: shippingPhone },
      lastShippingPrefill.current,
      defaults
    );
    lastShippingPrefill.current = defaults;
    setShippingAddress(next.address);
    setShippingCity(next.city);
    setShippingPhone(next.phone);
  }

  function selectCustomer(c: CustomerSearchResult) {
    setCustomer(c);
    prefillShipping(c);
    setCustomerOpen(false);
    setCustomerQuery("");
  }

  const customerNav = useListboxNavigation({
    id: "ord-customer",
    count: visibleCustomerResults.length,
    onSelect: (i) => {
      const c = visibleCustomerResults[i];
      if (c) selectCustomer(c);
    },
    onClose: () => openCustomerPicker(false),
  });

  // Product picker options, flattened (one per variation / simple product) so
  // the keyboard moves through exactly what is displayed.
  const productOptions = visibleProductResults.flatMap((p) =>
    p.variations.length > 0 ? p.variations.map((v) => ({ product: p, variation: v as ProductVariation | undefined })) : [{ product: p, variation: undefined }]
  );
  const productNav = useListboxNavigation({
    id: "ord-product",
    count: productOptions.length,
    onSelect: (i) => {
      const o = productOptions[i];
      if (o) addProductLine(o.product, o.variation);
    },
    onClose: () => openProductPicker(false),
  });

  function openNewCustomer() {
    setNewCustName(customerQuery.trim());
    setNewCustPhone("");
    setNewCustCity("");
    setNewCustAddress("");
    setNewCustomerMode(true);
  }

  function submitNewCustomer() {
    if (newCustName.trim().length < 2) {
      toast.error("Le nom du client est requis.");
      return;
    }
    setSavingCustomer(true);
    startTransition(async () => {
      const result = await createCustomerForOrderAction({
        fullName: newCustName.trim(),
        phone: newCustPhone.trim() || undefined,
        city: newCustCity.trim() || undefined,
        addressLine1: newCustAddress.trim() || undefined,
      });
      setSavingCustomer(false);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setCustomer(result.data);
      // Pre-fill THIS order's own shipping fields — the ones Livraison
      // actually checks — from the client feedback that a customer created
      // here, address and all, still showed up as "no address" once a
      // shipment was attempted: that gap was the order's own
      // shippingAddressLine1 never being set, only city/phone were.
      prefillShipping(result.data);
      setNewCustomerMode(false);
      setCustomerOpen(false);
      setCustomerQuery("");
      toast.success("Client créé.");
    });
  }

  function updateItem(key: string, patch: Partial<LineItem>) {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }

  function removeItem(key: string) {
    setItems((prev) => prev.filter((i) => i.key !== key));
  }

  const subtotal = items.reduce((sum, i) => sum + i.unitPrice * i.quantity - i.discount, 0);
  const total = subtotal - Number(discountTotal || 0) + Number(shippingCost || 0);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitOrder();
  }

  function submitOrder(override?: { token: string; reason: string }) {
    if (!customer) {
      toast.error("Sélectionnez un client.");
      return;
    }
    if (items.length === 0) {
      toast.error("Ajoutez au moins un article.");
      return;
    }
    setShortage(null);

    startTransition(async () => {
      const result = await createOrderAction({
        customerId: customer.id,
        fulfillmentWarehouseId: warehouses.length > 1 && fulfillmentWarehouseId ? fulfillmentWarehouseId : null,
        paymentMethod: paymentMethod as CreateOrderInputMethod,
        channel: channel as CreateOrderInputChannel,
        confirmationAgentId: confirmationAgentId || null,
        customerAlreadyConfirmed: canConfirm && customerAlreadyConfirmed,
        // P2: authorised override of a stock refusal for that immediate confirmation.
        stockOverrideToken: override?.token ?? null,
        stockOverrideReason: override?.reason ?? null,
        shippingCost: Number(shippingCost || 0),
        discountTotal: Number(discountTotal || 0),
        currency: "MAD",
        notes,
        internalNotes: "",
        shippingAddressLine1: shippingAddress,
        shippingAddressLine2: "",
        shippingCity,
        shippingRegion: "",
        shippingCountry: "Maroc",
        shippingPhone,
        items: items.map((i) => ({
          productId: i.productId ?? null,
          variationId: i.variationId ?? null,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          discount: i.discount,
        })),
      });

      const refusedForStock = stockShortageOf(result);
      if (refusedForStock) {
        setShortage(refusedForStock);
        return;
      }
      if (result.ok) {
        toast.success("Commande créée.");
        router.push(`/commandes/${result.data.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <StockOverrideDialog
        key={shortage?.token ?? "none"}
        shortage={shortage}
        pending={isPending}
        onCancel={() => setShortage(null)}
        onOverride={(token, reason) => submitOrder({ token, reason })}
      />
      {warehouses.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex size-6 items-center justify-center rounded-full bg-pill-peach text-xs font-semibold text-pill-peach-fg">1</span>
              Entrepôt de préparation
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Field>
              <Label htmlFor="ord-warehouse" className="sr-only">
                Entrepôt de préparation
              </Label>
              <Select value={fulfillmentWarehouseId} onValueChange={(v) => v && changeFulfillmentWarehouse(v)}>
                <SelectTrigger id="ord-warehouse" className="w-full sm:max-w-md">
                  <Warehouse className="size-4 text-muted-foreground" />
                  <SelectValue>
                    {(value: string) => {
                      const w = warehouses.find((x) => x.id === value);
                      return w ? `${w.name} (${WAREHOUSE_TYPE_LABELS[w.type]})` : value;
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name} ({WAREHOUSE_TYPE_LABELS[w.type]})
                      {w.isDefault ? " — par défaut" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldHint>
                D&apos;où part le stock — choisissez-le d&apos;abord : le stock affiché pour chaque article suit cet emplacement.
                La commande reste « En ligne » quel que soit l&apos;emplacement.
              </FieldHint>
            </Field>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {warehouses.length > 1 && (
              <span className="flex size-6 items-center justify-center rounded-full bg-pill-peach text-xs font-semibold text-pill-peach-fg">2</span>
            )}
            Client
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Popover open={customerOpen} onOpenChange={openCustomerPicker}>
            {customer ? (
              <div className="flex items-center gap-3 rounded-tile border border-hairline bg-row-hover px-3.5 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-pill-blue text-pill-blue-fg">
                  <UserRound className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{customer.fullName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[customer.phone, customer.email].filter(Boolean).join(" · ") || "Aucun contact enregistré"}
                  </p>
                </div>
                <PopoverTrigger render={<Button type="button" size="sm" variant="outline" />}>
                  <Search className="size-3.5" />
                  Changer
                </PopoverTrigger>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Retirer le client sélectionné"
                  onClick={() => setCustomer(null)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ) : (
              <PopoverTrigger render={<Button type="button" variant="outline" className="w-full justify-start font-normal text-muted-foreground" />}>
                <Search className="size-4" />
                Rechercher ou créer un client...
              </PopoverTrigger>
            )}
            {/* At least as wide as its trigger (the full-width search button), never narrower
                than a readable 22rem (the small « Changer » trigger), never wider than the viewport. */}
            <PopoverContent align="start" className="w-(--anchor-width) max-w-[calc(100vw-2rem)] min-w-[min(22rem,calc(100vw-2rem))] p-2">
              {newCustomerMode ? (
                <div className="space-y-2">
                  <p className="px-1 text-sm font-medium">Nouveau client</p>
                  <Input placeholder="Nom complet" value={newCustName} onChange={(e) => setNewCustName(e.target.value)} autoFocus />
                  <Input placeholder="Téléphone (optionnel)" value={newCustPhone} onChange={(e) => setNewCustPhone(e.target.value)} />
                  <Input placeholder="Adresse (optionnel)" value={newCustAddress} onChange={(e) => setNewCustAddress(e.target.value)} />
                  <CityInput placeholder="Ville (optionnel)" value={newCustCity} onValueChange={setNewCustCity} />
                  {newCustAddress.trim() && !newCustCity.trim() && (
                    <p className="px-1 text-xs text-muted-foreground">
                      La ville est nécessaire pour enregistrer cette adresse.
                    </p>
                  )}
                  <div className="flex gap-2 pt-1">
                    <Button type="button" size="sm" className="flex-1" disabled={savingCustomer} onClick={submitNewCustomer}>
                      {savingCustomer ? "Création..." : "Créer et sélectionner"}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setNewCustomerMode(false)}>
                      Annuler
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <Input
                    placeholder="Nom ou téléphone..."
                    aria-label="Rechercher un client"
                    value={customerQuery}
                    onChange={(e) => {
                      setCustomerQuery(e.target.value);
                      customerNav.reset();
                    }}
                    autoFocus
                    {...customerNav.inputProps}
                  />
                  {customerQueryEmpty && visibleCustomerResults.length > 0 && (
                    <p className="px-2 pt-2 text-xs font-medium text-muted-foreground">Clients récents</p>
                  )}
                  <div className="mt-1 max-h-64 overflow-y-auto" {...customerNav.listProps} aria-label="Clients">
                    {visibleCustomerResults.map((c, i) => (
                      <button
                        key={c.id}
                        type="button"
                        tabIndex={-1}
                        onClick={() => selectCustomer(c)}
                        {...customerNav.optionProps(i, customer?.id === c.id)}
                        className="flex w-full flex-col rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-row-hover data-[active]:bg-row-hover"
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="font-medium">{c.fullName}</span>
                          {customer?.id === c.id && <Check className="size-3.5 text-ink" aria-label="sélectionné" />}
                          {c.isBlacklisted && (
                            <Badge variant="destructive" className="h-5 px-1.5 text-xs">
                              Indésirable
                            </Badge>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {[c.phone ?? c.email, c.addresses[0]?.city].filter(Boolean).join(" · ")}
                        </span>
                      </button>
                    ))}
                    {(customerSearching || (customerQueryEmpty && initialCustomersLoading)) && (
                      <p className="px-2 py-1.5 text-sm text-muted-foreground" role="status">Recherche...</p>
                    )}
                    {customerSearchError && !customerSearching && (
                      <p className="px-2 py-1.5 text-sm text-destructive" role="alert">
                        La recherche a échoué. Réessayez.
                      </p>
                    )}
                    {!customerSearchError && customerQueryEmpty && initialCustomers !== null && initialCustomers.length === 0 && (
                      <p className="px-2 py-1.5 text-sm text-muted-foreground">Aucun client pour l&apos;instant.</p>
                    )}
                    {customerQuery.trim().length === 1 && (
                      <p className="px-2 py-1.5 text-sm text-muted-foreground">Tapez au moins 2 caractères.</p>
                    )}
                    {!customerSearchError && !customerSearching && customerQuery.trim().length >= 2 && visibleCustomerResults.length === 0 && (
                      <p className="px-2 py-1.5 text-sm text-muted-foreground">Aucun client trouvé.</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={openNewCustomer}
                    className="mt-1 flex w-full items-center gap-2 rounded-lg border-t border-hairline px-2 py-2 text-left text-sm font-medium text-ink hover:bg-nav-hover"
                  >
                    <Plus className="size-4" />
                    {customerQuery.trim().length >= 2
                      ? `Créer le client « ${customerQuery.trim()} »`
                      : "Créer un nouveau client"}
                  </button>
                </>
              )}
            </PopoverContent>
          </Popover>
          {customer?.isBlacklisted && (
            <Notice tone="danger" size="sm" className="mt-2">
              <ShieldAlert />
              <span>
                Ce client est marqué comme indésirable.
                {customer.blacklistReason ? ` Motif : ${customer.blacklistReason}` : ""} Vous pouvez tout de
                même créer la commande si vous le souhaitez.
              </span>
            </Notice>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Articles</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Popover open={productOpen} onOpenChange={openProductPicker}>
            <PopoverTrigger render={<Button type="button" variant="outline" />}>
              <Plus className="size-4" />
              Ajouter un produit
            </PopoverTrigger>
            <PopoverContent align="start" className="w-96 p-2">
              <div className="flex gap-2">
                <Input
                  placeholder="Nom, SKU ou code-barres..."
                  aria-label="Rechercher un produit"
                  value={productQuery}
                  onChange={(e) => {
                    setProductQuery(e.target.value);
                    productNav.reset();
                  }}
                  autoFocus
                  className="flex-1"
                  {...productNav.inputProps}
                />
                {/* A scan only fills the search: an exact code (barcode, label
                    QR, variation SKU) narrows to that one product / variation;
                    nothing is added without a click. */}
                <BarcodeScanButton
                  formats={LOOKUP_SCAN_FORMATS}
                  label=""
                  onDetect={(code) => {
                    setProductQuery(code);
                    productNav.reset();
                  }}
                />
              </div>
              {items.length > 0 && (
                <div className="mt-2 flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <SelectedLineChips lines={items} onRemove={removeItem} />
                  </div>
                  <Button type="button" size="sm" onClick={() => openProductPicker(false)}>
                    Terminé
                  </Button>
                </div>
              )}
              <div className="mt-2 max-h-64 overflow-y-auto" {...productNav.listProps} aria-label="Produits">
                {productOptions.map(({ product: p, variation: v }, i) => (
                  <button
                    key={v?.id ?? p.id}
                    type="button"
                    tabIndex={-1}
                    onClick={() => addProductLine(p, v)}
                    {...productNav.optionProps(i, isUnitInOrder(p.id, v?.id))}
                    className="flex w-full flex-col rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-row-hover data-[active]:bg-row-hover"
                  >
                    <span className="flex items-center gap-1.5 font-medium">
                      {v ? `${p.name} — ${Object.values(v.attributes as Record<string, string>).join(", ")}` : p.name}
                      {isUnitInOrder(p.id, v?.id) && <Check className="size-3.5 text-ink" aria-label="déjà ajouté" />}
                      <StockBadge stock={v ? v.stock : p.stock} />
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {v ? v.sku : p.sku} · {formatCurrency((v ? (v.salePrice ?? v.price ?? p.price) : p.price).toString())}
                    </span>
                  </button>
                ))}
                {(productSearching || (productQueryEmpty && initialProductsLoading)) && (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">Recherche...</p>
                )}
                {productQueryEmpty && initialProducts !== null && initialProducts.length === 0 && (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">Aucun produit actif.</p>
                )}
                {!productSearching && productQuery.trim().length >= 2 && visibleProductResults.length === 0 && (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">Aucun produit actif trouvé.</p>
                )}
              </div>
            </PopoverContent>
          </Popover>

          {items.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produit</TableHead>
                  <TableHead>Prix unitaire</TableHead>
                  <TableHead>Quantité</TableHead>
                  <TableHead>Remise</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((i) => (
                  <TableRow key={i.key}>
                    <TableCell>
                      <p className="font-medium">{i.label}</p>
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        {i.sku}
                        <StockBadge stock={lineStock[stockKey(i.stockProductId, i.variationId)]} requested={i.quantity} />
                      </p>
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        className="w-24"
                        value={i.unitPrice}
                        onChange={(e) => updateItem(i.key, { unitPrice: Number(e.target.value) })}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min="1"
                        className="w-20"
                        value={i.quantity}
                        onChange={(e) => updateItem(i.key, { quantity: Math.max(1, Number(e.target.value)) })}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        className="w-24"
                        value={i.discount}
                        onChange={(e) => updateItem(i.key, { discount: Number(e.target.value) })}
                      />
                    </TableCell>
                    <TableCell className="font-medium text-ink tabular-nums">{formatCurrency(i.unitPrice * i.quantity - i.discount)}</TableCell>
                    <TableCell>
                      <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeItem(i.key)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader className="border-b">
            <CardTitle>Livraison &amp; traitement</CardTitle>
          </CardHeader>
          <CardContent>
            <FormSectionGroup>
              <FormSection title="Adresse de livraison">
                <Field>
                  <Label htmlFor="ord-address">Adresse</Label>
                  <Input id="ord-address" value={shippingAddress} onChange={(e) => setShippingAddress(e.target.value)} placeholder="Rue, quartier, n°" />
                </Field>
                <FieldRow>
                  <Field>
                    <Label htmlFor="ord-city">Ville</Label>
                    <CityInput id="ord-city" value={shippingCity} onValueChange={setShippingCity} />
                  </Field>
                  <Field>
                    <Label htmlFor="ord-phone">Téléphone</Label>
                    <Input id="ord-phone" type="tel" value={shippingPhone} onChange={(e) => setShippingPhone(e.target.value)} />
                  </Field>
                </FieldRow>
                <Notice tone="warning" size="sm">
                  <AlertTriangle />
                  <span>
                    <strong>Important :</strong> {cityGuidanceMessage(cityGuidance)}
                  </span>
                </Notice>
              </FormSection>

              <FormSection title="Paiement & origine">
                <FieldRow>
                  <Field>
                    <Label>Méthode de paiement</Label>
                    <Select value={paymentMethod} onValueChange={(v) => v && setPaymentMethod(v)}>
                      <SelectTrigger className="w-full">
                        <SelectValue>{(value: string) => PAYMENT_METHOD_LABELS[value] ?? value}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <Label>Canal de la commande</Label>
                    <Select value={channel} onValueChange={(v) => v && setChannel(v)}>
                      <SelectTrigger className="w-full">
                        <SelectValue>{(value: string) => ORDER_CHANNEL_LABELS[value] ?? value}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(ORDER_CHANNEL_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </FieldRow>
                {canConfirm && (
                  <label
                    htmlFor="ord-already-confirmed"
                    className="flex cursor-pointer items-start gap-3 rounded-tile border border-field-border px-3.5 py-3 transition-colors hover:border-field-border-hover has-data-checked:border-transparent has-data-checked:bg-pill-peach/60"
                  >
                    <Switch
                      id="ord-already-confirmed"
                      className="mt-0.5"
                      checked={customerAlreadyConfirmed}
                      onCheckedChange={setCustomerAlreadyConfirmed}
                    />
                    <span className="space-y-0.5">
                      <span className="block text-sm font-medium">Client déjà confirmé</span>
                      <span className="block text-xs text-muted-foreground">
                        {customerAlreadyConfirmed
                          ? "Le client a déjà confirmé sa commande (WhatsApp, téléphone, Instagram…) : elle est créée « Confirmée », le stock est réservé et elle n'entre pas dans la file de confirmation."
                          : "Client pas encore confirmé : la commande est créée « Nouvelle » et entre dans la file de confirmation."}
                      </span>
                    </span>
                  </label>
                )}
                {commissionAgents.length > 0 && (
                  <FieldRow>
                    {commissionAgents.length > 0 && (
                      <Field>
                        <Label>Agent de confirmation</Label>
                        <Select value={confirmationAgentId || "__none__"} onValueChange={(v) => setConfirmationAgentId(v === "__none__" ? "" : (v ?? ""))}>
                          <SelectTrigger className="w-full">
                            <SelectValue>
                              {(value: string) =>
                                value === "__none__" ? "Aucun" : commissionAgents.find((a) => a.id === value)?.name ?? "Aucun"
                              }
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">Aucun</SelectItem>
                            {commissionAgents.map((a) => (
                              <SelectItem key={a.id} value={a.id}>
                                {a.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                    )}
                  </FieldRow>
                )}
              </FormSection>
            </FormSectionGroup>
          </CardContent>
        </Card>

        <Card className="lg:sticky lg:top-20">
          <CardHeader className="border-b">
            <CardTitle>Résumé</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FieldRow>
              <Field>
                <Label htmlFor="ord-shipping">Frais de livraison</Label>
                <Input id="ord-shipping" type="number" step="0.01" min="0" className="tabular-nums" value={shippingCost} onChange={(e) => setShippingCost(e.target.value)} />
              </Field>
              <Field>
                <Label htmlFor="ord-discount">Remise globale</Label>
                <Input id="ord-discount" type="number" step="0.01" min="0" className="tabular-nums" value={discountTotal} onChange={(e) => setDiscountTotal(e.target.value)} />
              </Field>
            </FieldRow>
            <Field>
              <Label htmlFor="ord-notes">Notes (visibles client)</Label>
              <Textarea id="ord-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Instructions de livraison, créneau…" />
            </Field>
            <div className="space-y-1.5 rounded-tile bg-row-hover p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Sous-total</span>
                <span className="tabular-nums">{formatCurrency(subtotal)}</span>
              </div>
              <div className="flex items-baseline justify-between border-t border-hairline pt-2">
                <span className="font-medium">Total</span>
                <span className="text-xl font-semibold tracking-tight text-ink tabular-nums">{formatCurrency(total)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <FormActions
        context={
          <span>
            Total <span className="text-base font-semibold text-foreground tabular-nums">{formatCurrency(total)}</span>
          </span>
        }
      >
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Annuler
        </Button>
        <Button type="submit" loading={isPending}>
          Créer la commande
        </Button>
      </FormActions>
    </form>
  );
}

type CreateOrderInputMethod = "PAIEMENT_LIVRAISON" | "VIREMENT_BANCAIRE" | "CARTE_BANCAIRE" | "MOBILE_MONEY" | "AUTRE";
type CreateOrderInputChannel = "TELEPHONE" | "WHATSAPP" | "INSTAGRAM" | "FACEBOOK" | "SITE_WEB" | "AUTRE";

function stockKey(productId: string, variationId?: string | null): string {
  return variationId ? `v:${variationId}` : `p:${productId}`;
}

/**
 * P2 — stock at the selected fulfilment warehouse, quantity only. With
 * `requested`, warns when the line asks for more than is available (the
 * confirmation would then be refused unless a manager overrides it).
 */
function StockBadge({ stock, requested }: { stock?: PickerStock; requested?: number }) {
  if (!stock) return null;
  if (stock.state !== "tracked") {
    return (
      <Badge variant="outline" className="font-normal">
        {stock.state === "no_warehouse" ? "Stock : emplacement inconnu" : "Stock non suivi"}
      </Badge>
    );
  }
  const short = requested !== undefined ? requested > stock.available : stock.available <= 0;
  const label =
    stock.available <= 0
      ? stock.reserved > stock.onHand
        ? "Rupture (surréservé)"
        : "Rupture"
      : `Stock : ${stock.available}`;
  return (
    <Badge variant={short ? "warning" : "secondary"} className="font-normal" title={`En stock ${stock.onHand}, réservé ${stock.reserved}`}>
      {label}
      {requested !== undefined && short && stock.available > 0 ? ` (demandé ${requested})` : ""}
    </Badge>
  );
}
