"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, Search } from "lucide-react";
import {
  createOrderAction,
  createCustomerForOrderAction,
  searchCustomersForOrderAction,
  searchProductsForOrderAction,
} from "@/actions/orders";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatCurrency } from "@/lib/format";
import { PAYMENT_METHOD_LABELS, WAREHOUSE_TYPE_LABELS } from "@/lib/status-labels";
import type { Customer } from "@prisma/client";

interface SelectableWarehouse {
  id: string;
  name: string;
  type: "ENTREPOT" | "MAGASIN";
  isDefault: boolean;
}

type ProductWithVariations = Awaited<ReturnType<typeof searchProductsForOrderAction>>[number];
type ProductVariation = ProductWithVariations["variations"][number];

interface LineItem {
  key: string;
  productId?: string;
  variationId?: string;
  label: string;
  sku: string;
  unitPrice: number;
  quantity: number;
  discount: number;
}

export function OrderForm({ warehouses = [] }: { warehouses?: SelectableWarehouse[] }) {
  const router = useRouter();
  const defaultWarehouseId = warehouses.find((w) => w.isDefault)?.id ?? warehouses[0]?.id ?? "";
  const [fulfillmentWarehouseId, setFulfillmentWarehouseId] = React.useState(defaultWarehouseId);
  const [customer, setCustomer] = React.useState<Customer | null>(null);
  const [customerQuery, setCustomerQuery] = React.useState("");
  const [customerResults, setCustomerResults] = React.useState<Customer[]>([]);
  const [customerOpen, setCustomerOpen] = React.useState(false);
  // Inline "create a new client" panel inside the customer popover.
  const [newCustomerMode, setNewCustomerMode] = React.useState(false);
  const [newCustName, setNewCustName] = React.useState("");
  const [newCustPhone, setNewCustPhone] = React.useState("");
  const [newCustCity, setNewCustCity] = React.useState("");
  const [savingCustomer, setSavingCustomer] = React.useState(false);

  const [productQuery, setProductQuery] = React.useState("");
  const [productResults, setProductResults] = React.useState<ProductWithVariations[]>([]);
  const [productOpen, setProductOpen] = React.useState(false);

  const [items, setItems] = React.useState<LineItem[]>([]);
  const [paymentMethod, setPaymentMethod] = React.useState("PAIEMENT_LIVRAISON");
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

  React.useEffect(() => {
    if (customerQuery.trim().length < 2) return;
    const t = setTimeout(async () => {
      const q = customerQuery.trim();
      const results = await searchCustomersForOrderAction(customerQuery);
      setCustomerResults(results);
      setCustomerSearchedFor(q);
    }, 120);
    return () => clearTimeout(t);
  }, [customerQuery]);
  // Query too short for a server round-trip — don't show stale results from a longer query.
  const visibleCustomerResults = customerQuery.trim().length >= 2 ? customerResults : [];

  React.useEffect(() => {
    if (productQuery.trim().length < 2) return;
    const t = setTimeout(async () => {
      const q = productQuery.trim();
      const results = await searchProductsForOrderAction(productQuery);
      setProductResults(results);
      setProductSearchedFor(q);
    }, 120);
    return () => clearTimeout(t);
  }, [productQuery]);
  const visibleProductResults = productQuery.trim().length >= 2 ? productResults : [];

  function addProductLine(product: ProductWithVariations, variation?: ProductVariation) {
    setItems((prev) => [
      ...prev,
      {
        key: `${product.id}-${variation?.id ?? "base"}-${Date.now()}`,
        productId: variation ? undefined : product.id,
        variationId: variation?.id,
        label: variation ? `${product.name} (${Object.values(variation.attributes as Record<string, string>).join(", ")})` : product.name,
        sku: variation?.sku ?? product.sku,
        unitPrice: Number(variation?.price ?? product.price),
        quantity: 1,
        discount: 0,
      },
    ]);
    setProductOpen(false);
    setProductQuery("");
  }

  function openNewCustomer() {
    setNewCustName(customerQuery.trim());
    setNewCustPhone("");
    setNewCustCity("");
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
      });
      setSavingCustomer(false);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setCustomer(result.data);
      if (result.data.city) setShippingCity(result.data.city);
      if (result.data.phone) setShippingPhone(result.data.phone);
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
    if (!customer) {
      toast.error("Sélectionnez un client.");
      return;
    }
    if (items.length === 0) {
      toast.error("Ajoutez au moins un article.");
      return;
    }

    startTransition(async () => {
      const result = await createOrderAction({
        customerId: customer.id,
        fulfillmentWarehouseId: warehouses.length > 1 && fulfillmentWarehouseId ? fulfillmentWarehouseId : null,
        paymentMethod: paymentMethod as CreateOrderInputMethod,
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
      <Card>
        <CardHeader>
          <CardTitle>Client</CardTitle>
        </CardHeader>
        <CardContent>
          <Popover
            open={customerOpen}
            onOpenChange={(open) => {
              setCustomerOpen(open);
              if (!open) setNewCustomerMode(false);
            }}
          >
            <PopoverTrigger
              render={<Button type="button" variant="outline" className="w-full justify-start" />}
            >
              <Search className="size-4" />
              {customer ? customer.fullName : "Rechercher un client..."}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 p-2">
              {newCustomerMode ? (
                <div className="space-y-2">
                  <p className="px-1 text-sm font-medium">Nouveau client</p>
                  <Input placeholder="Nom complet" value={newCustName} onChange={(e) => setNewCustName(e.target.value)} autoFocus />
                  <Input placeholder="Téléphone (optionnel)" value={newCustPhone} onChange={(e) => setNewCustPhone(e.target.value)} />
                  <Input placeholder="Ville (optionnel)" value={newCustCity} onChange={(e) => setNewCustCity(e.target.value)} />
                  <div className="flex gap-2 pt-1">
                    <Button type="button" size="sm" className="flex-1" disabled={savingCustomer} onClick={submitNewCustomer}>
                      {savingCustomer ? "Création..." : "Créer et sélectionner"}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setNewCustomerMode(false)}>
                      Annuler
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <Input
                    placeholder="Nom ou téléphone..."
                    value={customerQuery}
                    onChange={(e) => setCustomerQuery(e.target.value)}
                    autoFocus
                  />
                  <div className="mt-2 max-h-56 overflow-y-auto">
                    {visibleCustomerResults.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setCustomer(c);
                          setCustomerOpen(false);
                        }}
                        className="flex w-full flex-col rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                      >
                        <span className="font-medium">{c.fullName}</span>
                        <span className="text-xs text-muted-foreground">{c.phone ?? c.email ?? ""}</span>
                      </button>
                    ))}
                    {customerSearching && (
                      <p className="px-2 py-1.5 text-sm text-muted-foreground">Recherche...</p>
                    )}
                    {!customerSearching && customerQuery.trim().length >= 2 && visibleCustomerResults.length === 0 && (
                      <p className="px-2 py-1.5 text-sm text-muted-foreground">Aucun client trouvé.</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={openNewCustomer}
                    className="mt-1 flex w-full items-center gap-2 rounded-md border-t px-2 py-2 text-left text-sm font-medium text-primary hover:bg-muted"
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Articles</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Popover open={productOpen} onOpenChange={setProductOpen}>
            <PopoverTrigger render={<Button type="button" variant="outline" />}>
              <Plus className="size-4" />
              Ajouter un produit
            </PopoverTrigger>
            <PopoverContent align="start" className="w-96 p-2">
              <Input
                placeholder="Nom ou SKU..."
                value={productQuery}
                onChange={(e) => setProductQuery(e.target.value)}
                autoFocus
              />
              <div className="mt-2 max-h-64 overflow-y-auto">
                {visibleProductResults.map((p) =>
                  p.variations.length > 0 ? (
                    p.variations.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => addProductLine(p, v)}
                        className="flex w-full flex-col rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                      >
                        <span className="font-medium">
                          {p.name} — {Object.values(v.attributes as Record<string, string>).join(", ")}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {v.sku} · {formatCurrency((v.price ?? p.price).toString())}
                        </span>
                      </button>
                    ))
                  ) : (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => addProductLine(p)}
                      className="flex w-full flex-col rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      <span className="font-medium">{p.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {p.sku} · {formatCurrency(p.price.toString())}
                      </span>
                    </button>
                  )
                )}
                {productSearching && (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">Recherche...</p>
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
                      <p className="text-xs text-muted-foreground">{i.sku}</p>
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
                    <TableCell>{formatCurrency(i.unitPrice * i.quantity - i.discount)}</TableCell>
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

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Livraison &amp; paiement</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
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
            </div>
            {warehouses.length > 1 && (
              <div className="space-y-1.5">
                <Label>Entrepôt de préparation</Label>
                <Select
                  value={fulfillmentWarehouseId}
                  onValueChange={(v) => v && setFulfillmentWarehouseId(v)}
                >
                  <SelectTrigger className="w-full">
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
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Adresse de livraison</Label>
              <Input value={shippingAddress} onChange={(e) => setShippingAddress(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Ville</Label>
                <Input value={shippingCity} onChange={(e) => setShippingCity(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Téléphone</Label>
                <Input value={shippingPhone} onChange={(e) => setShippingPhone(e.target.value)} />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Résumé</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Frais de livraison</Label>
                <Input type="number" step="0.01" min="0" value={shippingCost} onChange={(e) => setShippingCost(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Remise globale</Label>
                <Input type="number" step="0.01" min="0" value={discountTotal} onChange={(e) => setDiscountTotal(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Notes (visibles client)</Label>
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <div className="space-y-1 border-t pt-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Sous-total</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              <div className="flex justify-between font-medium">
                <span>Total</span>
                <span>{formatCurrency(total)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Annuler
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Création..." : "Créer la commande"}
        </Button>
      </div>
    </form>
  );
}

type CreateOrderInputMethod = "PAIEMENT_LIVRAISON" | "VIREMENT_BANCAIRE" | "CARTE_BANCAIRE" | "MOBILE_MONEY" | "AUTRE";
