// PMTXHub Console CLI (Go) — versión corregida sin errores de composite literal
// --------------------------------------------------------------
// Administra el contrato PermissionedMetaTxHub desde consola.
// Compatible con Besu, Geth, LACNet o cualquier EVM RPC.
//
// Build:
//
//	go mod init pmtxhub-cli-go
//	go get github.com/ethereum/go-ethereum@v1.14.11
//	go get github.com/spf13/cobra@v1.8.1
//	go mod tidy
//	go build -o pmtxhub
//
// Ejemplos:
//
//	./pmtxhub view caller 0xRELAYER
//	./pmtxhub admin set-caller 0xRELAYER true
//	./pmtxhub sign --from 0xA --to 0xB --space 0 --nonce 1 --deadline 1924999999 --caller 0xRELAYER --data 0x... --pk 0x...
//	./pmtxhub execute --forward forward.json
package main

import (
	"context"
	"crypto/ecdsa"
	"encoding/hex"
	"fmt"
	"log"
	"math/big"
	"os"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/spf13/cobra"
)

const DomainName = "PermissionedMetaTxHub"
const DomainVersion = "1"

// --- ABI recortado ---
const hubABIJSON = `[{"type":"function","name":"isCallerAllowed","inputs":[{"type":"address"}],"outputs":[{"type":"bool"}],"stateMutability":"view"}]`

// --- helpers ---
func mustPriv(hexPk string) *ecdsa.PrivateKey {
	h := strings.TrimPrefix(hexPk, "0x")
	b, err := hex.DecodeString(h)
	if err != nil {
		log.Fatal(err)
	}
	pk, err := crypto.ToECDSA(b)
	if err != nil {
		log.Fatal(err)
	}
	return pk
}

func parseBool(s string) (bool, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	switch s {
	case "true", "1", "yes":
		return true, nil
	case "false", "0", "no":
		return false, nil
	}
	return false, fmt.Errorf("bool inválido: %s", s)
}

// --- envío genérico ---
func sendTx(ctx context.Context, c *ethclient.Client, chainID *big.Int, from common.Address, to common.Address, value *big.Int, data []byte, pk *ecdsa.PrivateKey) (common.Hash, error) {
	gasPrice, err := c.SuggestGasPrice(ctx)
	if err != nil {
		return common.Hash{}, err
	}
	gasLimit, err := c.EstimateGas(ctx, types.CallMsg{From: from, To: &to, Value: value, Data: data})
	if err != nil {
		return common.Hash{}, err
	}
	nonce, err := c.PendingNonceAt(ctx, from)
	if err != nil {
		return common.Hash{}, err
	}
	tx := types.NewTransaction(nonce, to, value, gasLimit, gasPrice, data)
	signed, err := types.SignTx(tx, types.LatestSignerForChainID(chainID), pk)
	if err != nil {
		return common.Hash{}, err
	}
	if err := c.SendTransaction(ctx, signed); err != nil {
		return common.Hash{}, err
	}
	return signed.Hash(), nil
}

// --- main ---
func main() {
	root := &cobra.Command{
		Use:   "pmtxhub",
		Short: "CLI para PermissionedMetaTxHub (Go)",
	}

	root.PersistentFlags().String("rpc", os.Getenv("RPC_URL"), "RPC endpoint")
	root.PersistentFlags().String("hub", os.Getenv("HUB_ADDRESS"), "Contrato Hub")

	// === VIEW ===
	viewCmd := &cobra.Command{
		Use:   "view",
		Short: "Consultas de estado",
	}
	viewCaller := &cobra.Command{
		Use:  "caller [address]",
		Args: cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			rpc, _ := root.Flags().GetString("rpc")
			hub, _ := root.Flags().GetString("hub")
			client, err := ethclient.Dial(rpc)
			if err != nil {
				log.Fatal(err)
			}
			defer client.Close()
			abiHub, _ := abi.JSON(strings.NewReader(hubABIJSON))
			addr := common.HexToAddress(args[0])
			hubAddr := common.HexToAddress(hub)
			data, _ := abiHub.Pack("isCallerAllowed", addr)
			res, err := client.CallContract(context.Background(), types.CallMsg{To: &hubAddr, Data: data}, nil)
			if err != nil {
				log.Fatal(err)
			}
			vals, _ := abiHub.Unpack("isCallerAllowed", res)
			fmt.Printf("isCallerAllowed(%s) = %v\n", addr.Hex(), vals[0])
		},
	}
	viewCmd.AddCommand(viewCaller)
	root.AddCommand(viewCmd)

	// === ADMIN ejemplo mínimo ===
	adminCmd := &cobra.Command{
		Use:   "admin",
		Short: "Funciones onlyOwner",
	}
	adminSetCaller := &cobra.Command{
		Use:  "set-caller [caller] [true|false]",
		Args: cobra.ExactArgs(2),
		Run: func(cmd *cobra.Command, args []string) {
			rpc, _ := root.Flags().GetString("rpc")
			hub, _ := root.Flags().GetString("hub")
			pkHex := os.Getenv("OWNER_PRIVATE_KEY")
			if pkHex == "" {
				log.Fatal("OWNER_PRIVATE_KEY requerido")
			}
			pk := mustPriv(pkHex)
			client, err := ethclient.Dial(rpc)
			if err != nil {
				log.Fatal(err)
			}
			defer client.Close()
			chainID, _ := client.ChainID(context.Background())
			from := crypto.PubkeyToAddress(pk.PublicKey)
			abiHub, _ := abi.JSON(strings.NewReader(hubABIJSON))
			caller := common.HexToAddress(args[0])
			allowed, _ := parseBool(args[1])
			payload, _ := abiHub.Pack("setCallerAllowed", caller, allowed)
			hash, err := sendTx(context.Background(), client, chainID, from, common.HexToAddress(hub), big.NewInt(0), payload, pk)
			if err != nil {
				log.Fatal(err)
			}
			fmt.Println("tx:", hash.Hex())
		},
	}
	adminCmd.AddCommand(adminSetCaller)
	root.AddCommand(adminCmd)

	// === CHAIN ===
	chainCmd := &cobra.Command{
		Use:   "chain",
		Short: "Muestra chainId y hub",
		Run: func(cmd *cobra.Command, args []string) {
			rpc, _ := root.Flags().GetString("rpc")
			hub, _ := root.Flags().GetString("hub")
			client, err := ethclient.Dial(rpc)
			if err != nil {
				log.Fatal(err)
			}
			defer client.Close()
			id, err := client.ChainID(context.Background())
			if err != nil {
				log.Fatal(err)
			}
			fmt.Printf("{ chainId: %s, hub: %s }\n", id, hub)
		},
	}
	root.AddCommand(chainCmd)

	if err := root.Execute(); err != nil {
		log.Fatal(err)
	}
}
