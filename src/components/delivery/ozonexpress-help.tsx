import { HelpCircle } from "lucide-react";

/**
 * Plain-language, non-technical guide to the OzonExpress connector, shown
 * on the Prestataires tab. Native <details> — no JS, works in an RSC.
 */
export function OzonExpressHelp() {
  return (
    <details className="rounded-lg border bg-muted/30 p-4 text-sm [&_summary]:cursor-pointer">
      <summary className="flex items-center gap-2 font-medium">
        <HelpCircle className="size-4" />
        Comment utiliser OzonExpress
      </summary>

      <div className="mt-3 space-y-4 text-muted-foreground">
        <section className="space-y-1">
          <p className="font-medium text-foreground">1. Obtenir vos identifiants</p>
          <p>
            Dans votre compte OzonExpress : <span className="text-foreground">Compte → « Generate your API key »</span>. Vous
            obtenez deux valeurs : votre <span className="text-foreground">identifiant client</span> et votre{" "}
            <span className="text-foreground">clé API</span>.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">2. Connecter OzonExpress à ce projet</p>
          <p>
            Créez un prestataire de type « API », choisissez le connecteur « OzonExpress », collez l&apos;identifiant
            client et la clé API, puis cliquez sur <span className="text-foreground">« Tester la connexion »</span>. Le
            statut passe à « Connecté » uniquement si le test réussit.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">3. Deux façons de créer les colis</p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              <span className="text-foreground">Création par ce projet (par défaut)</span> : dans l&apos;onglet « À
              expédier », choisissez OzonExpress pour une commande — le projet crée le colis chez OzonExpress et récupère
              le numéro de suivi automatiquement.
            </li>
            <li>
              <span className="text-foreground">Création par la boutique</span> : si votre site (WooCommerce / Shopify)
              possède déjà un module qui crée le colis OzonExpress à la commande, activez l&apos;option «&nbsp;Les colis
              sont créés par la boutique&nbsp;» sur ce prestataire. Le projet ne créera plus de colis en double — vous
              utilisez « Créer une expédition » et saisissez le numéro de suivi fourni par OzonExpress.
            </li>
          </ul>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">4. Correspondance des villes</p>
          <p>
            OzonExpress identifie les villes par un numéro. Le projet fait la correspondance automatiquement à partir de
            la liste des villes d&apos;OzonExpress. Si une ville de commande n&apos;est pas reconnue (orthographe
            différente), ajoutez une correspondance précise depuis « Correspondances de villes ».
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">5. Suivi &amp; statuts</p>
          <p>
            Le numéro de suivi et son lien apparaissent dans la colonne « Suivi » de l&apos;onglet « Expéditions ».
            Quand OzonExpress marque un colis <span className="text-foreground">livré</span>, la commande passe
            automatiquement à « Livrée » ici — et sur votre boutique WooCommerce à « Terminée ». Utilisez «&nbsp;Rafraîchir
            le statut&nbsp;» sur une expédition pour forcer la mise à jour depuis OzonExpress.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">6. Bon de livraison (remise au transporteur)</p>
          <p>
            L&apos;onglet « Bons de livraison » regroupe plusieurs colis « En attente » d&apos;un même transporteur sur un
            bordereau. Une fois généré, le bordereau et les étiquettes s&apos;ouvrent sur le portail OzonExpress où vous
            êtes déjà connecté.
          </p>
        </section>
      </div>
    </details>
  );
}
