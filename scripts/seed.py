import os
import sys
import psycopg2
import random
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
from dotenv import load_dotenv

# Load .env from project root
env_path = Path(__file__).parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

def get_connection():
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        print("Error: DATABASE_URL environment variable not set.")
        sys.exit(1)
    return psycopg2.connect(db_url)

def get_or_create_account(cur, full_name, account_type):
    parts = full_name.split(':')
    parent_id = None
    
    for part in parts:
        if parent_id is None:
            cur.execute("SELECT id FROM accounts WHERE name = %s AND parent_id IS NULL", (part,))
        else:
            cur.execute("SELECT id FROM accounts WHERE name = %s AND parent_id = %s", (part, parent_id))
        
        row = cur.fetchone()
        if row:
            parent_id = row[0]
        else:
            cur.execute(
                "INSERT INTO accounts (name, type, parent_id) VALUES (%s, %s, %s) RETURNING id",
                (part, account_type, parent_id)
            )
            parent_id = cur.fetchone()[0]
    
    return parent_id

ACCOUNTS = {
    'itau': ('assets:itau', 'asset', 'BRL'),
    'nuconta': ('assets:nuconta', 'asset', 'BRL'),
    'cartao_nubank': ('liabilities:cartao nubank', 'liability', 'BRL'),
    'wise': ('assets:wise', 'asset', 'USD'),
}

CATEGORIES = {
    'mercado': ('expenses:alimentação:mercado', 'expense'),
    'restaurante': ('expenses:alimentação:restaurante', 'expense'),
    'lanche': ('expenses:alimentação:lanche', 'expense'),
    'uber': ('expenses:transporte:uber', 'expense'),
    'combustivel': ('expenses:transporte:combustível', 'expense'),
    'estacionamento': ('expenses:transporte:estacionamento', 'expense'),
    'aluguel': ('expenses:moradia:aluguel', 'expense'),
    'condominio': ('expenses:moradia:condomínio', 'expense'),
    'energia': ('expenses:moradia:energia', 'expense'),
    'agua': ('expenses:moradia:água', 'expense'),
    'internet': ('expenses:moradia:internet', 'expense'),
    'cinema': ('expenses:lazer:cinema', 'expense'),
    'viagem': ('expenses:lazer:viagem', 'expense'),
    'jogos': ('expenses:lazer:jogos', 'expense'),
    'farmacia': ('expenses:saúde:farmácia', 'expense'),
    'academia': ('expenses:saúde:academia', 'expense'),
    'cursos': ('expenses:educação:cursos', 'expense'),
    'livros': ('expenses:educação:livros', 'expense'),
    'netflix': ('expenses:assinaturas:netflix', 'expense'),
    'spotify': ('expenses:assinaturas:spotify', 'expense'),
    'salario': ('income:salário', 'income'),
    'freelance': ('income:freelance', 'income'),
    'investimentos': ('income:investimentos', 'income'),
}

DESCRIPTIONS = {
    'mercado': ['Pão de Açúcar', 'Carrefour', 'Extra', 'Mercado de Bairro', 'Hortifruti'],
    'restaurante': ['Outback', 'Madero', 'Restaurante da Esquina', 'Japonês', 'Italiano'],
    'lanche': ['McDonalds', 'Burger King', 'Padaria', 'Cafeteria', 'iFood'],
    'uber': ['Uber Trip', '99 Pop'],
    'combustivel': ['Posto Shell', 'Posto Ipiranga', 'Posto BR'],
    'estacionamento': ['Estacionamento Shopping', 'Zona Azul'],
    'aluguel': ['Aluguel Apartamento'],
    'condominio': ['Condomínio'],
    'energia': ['Enel', 'Light'],
    'agua': ['Sabesp', 'Cedae'],
    'internet': ['Vivo Fibra', 'Claro NET'],
    'cinema': ['Cinemark', 'Cinépolis'],
    'viagem': ['Passagem Aérea', 'Hotel', 'Airbnb'],
    'jogos': ['Steam', 'PlayStation Store', 'Xbox'],
    'farmacia': ['Droga Raia', 'Drogasil', 'Farmácia Popular'],
    'academia': ['Smart Fit', 'Bio Ritmo'],
    'cursos': ['Udemy', 'Coursera', 'Alura'],
    'livros': ['Amazon Livros', 'Livraria Cultura'],
    'netflix': ['Netflix'],
    'spotify': ['Spotify'],
    'salario': ['Salário Mensal'],
    'freelance': ['Projeto Freelance', 'Consultoria'],
    'investimentos': ['Dividendos', 'Rendimento CDB'],
}

def seed():
    conn = get_connection()
    cur = conn.cursor()
    
    print("Creating accounts...")
    account_ids = {}
    for key, (name, type, currency) in ACCOUNTS.items():
        account_ids[key] = get_or_create_account(cur, name, type)
        
    category_ids = {}
    for key, (name, type) in CATEGORIES.items():
        category_ids[key] = get_or_create_account(cur, name, type)
        
    print("Generating 1000 transactions...")
    
    start_date = datetime.now() - timedelta(days=180)
    
    for _ in range(1000):
        # Pick a random date
        days_offset = random.randint(0, 180)
        date = (start_date + timedelta(days=days_offset)).date()
        
        # Determine type: expense (80%), income (15%), transfer (5%)
        rand = random.random()
        if rand < 0.80:
            # Expense
            cat_key = random.choice([k for k, v in CATEGORIES.items() if v[1] == 'expense'])
            acc_key = random.choice(list(ACCOUNTS.keys()))
            
            desc = random.choice(DESCRIPTIONS.get(cat_key, [cat_key.capitalize()]))
            amount = Decimal(str(random.uniform(5, 200))).quantize(Decimal('0.01'))
            
            # Rent, Condo, etc. are fixed
            if cat_key == 'aluguel': amount = Decimal('2500.00')
            elif cat_key == 'condominio': amount = Decimal('600.00')
            elif cat_key == 'internet': amount = Decimal('120.00')
            elif cat_key == 'netflix': amount = Decimal('55.90')
            elif cat_key == 'spotify': amount = Decimal('21.90')
            
            currency = ACCOUNTS[acc_key][2]
            exchange_rate = Decimal('1.0')
            if currency == 'USD':
                exchange_rate = Decimal(str(random.uniform(5.0, 5.5))).quantize(Decimal('0.01'))
            
            amount_base = (amount * exchange_rate).quantize(Decimal('0.01'))
            
            # Create transaction
            cur.execute(
                "INSERT INTO transactions (date, description) VALUES (%s, %s) RETURNING id",
                (date, desc)
            )
            tx_id = cur.fetchone()[0]
            
            # Entry 1: Expense account (+)
            cur.execute(
                "INSERT INTO entries (transaction_id, account_id, amount, currency, exchange_rate, amount_base) VALUES (%s, %s, %s, %s, %s, %s)",
                (tx_id, category_ids[cat_key], amount, currency, exchange_rate, amount_base)
            )
            
            # Entry 2: Asset/Liability account (-)
            cur.execute(
                "INSERT INTO entries (transaction_id, account_id, amount, currency, exchange_rate, amount_base) VALUES (%s, %s, %s, %s, %s, %s)",
                (tx_id, account_ids[acc_key], -amount, currency, exchange_rate, -amount_base)
            )
            
        elif rand < 0.95:
            # Income
            cat_key = random.choice([k for k, v in CATEGORIES.items() if v[1] == 'income'])
            acc_key = random.choice(['itau', 'nuconta']) # Income only to BRL accounts
            
            desc = random.choice(DESCRIPTIONS.get(cat_key, [cat_key.capitalize()]))
            
            if cat_key == 'salario':
                amount = Decimal('8000.00')
            else:
                amount = Decimal(str(random.uniform(100, 2000))).quantize(Decimal('0.01'))
                
            currency = 'BRL'
            exchange_rate = Decimal('1.0')
            amount_base = amount
            
            # Create transaction
            cur.execute(
                "INSERT INTO transactions (date, description) VALUES (%s, %s) RETURNING id",
                (date, desc)
            )
            tx_id = cur.fetchone()[0]
            
            # Entry 1: Asset account (+)
            cur.execute(
                "INSERT INTO entries (transaction_id, account_id, amount, currency, exchange_rate, amount_base) VALUES (%s, %s, %s, %s, %s, %s)",
                (tx_id, account_ids[acc_key], amount, currency, exchange_rate, amount_base)
            )
            
            # Entry 2: Income account (-)
            cur.execute(
                "INSERT INTO entries (transaction_id, account_id, amount, currency, exchange_rate, amount_base) VALUES (%s, %s, %s, %s, %s, %s)",
                (tx_id, category_ids[cat_key], -amount, currency, exchange_rate, -amount_base)
            )
        else:
            # Transfer
            acc_from_key = random.choice(list(ACCOUNTS.keys()))
            acc_to_key = random.choice([k for k in ACCOUNTS.keys() if k != acc_from_key])
            
            amount = Decimal(str(random.uniform(50, 500))).quantize(Decimal('0.01'))
            desc = f"Transferência {acc_from_key} -> {acc_to_key}"
            
            cur_from = ACCOUNTS[acc_from_key][2]
            cur_to = ACCOUNTS[acc_to_key][2]
            
            # Create transaction
            cur.execute(
                "INSERT INTO transactions (date, description) VALUES (%s, %s) RETURNING id",
                (date, desc)
            )
            tx_id = cur.fetchone()[0]
            
            if cur_from == cur_to:
                exchange_rate = Decimal('1.0')
                if cur_from == 'USD':
                    exchange_rate = Decimal(str(random.uniform(5.0, 5.5))).quantize(Decimal('0.01'))
                
                amount_base = (amount * exchange_rate).quantize(Decimal('0.01'))
                
                # Entry 1: From (-)
                cur.execute(
                    "INSERT INTO entries (transaction_id, account_id, amount, currency, exchange_rate, amount_base) VALUES (%s, %s, %s, %s, %s, %s)",
                    (tx_id, account_ids[acc_from_key], -amount, cur_from, exchange_rate, -amount_base)
                )
                # Entry 2: To (+)
                cur.execute(
                    "INSERT INTO entries (transaction_id, account_id, amount, currency, exchange_rate, amount_base) VALUES (%s, %s, %s, %s, %s, %s)",
                    (tx_id, account_ids[acc_to_key], amount, cur_to, exchange_rate, amount_base)
                )
            else:
                # Cross-currency transfer
                if cur_from == 'BRL' and cur_to == 'USD':
                    exchange_rate = Decimal(str(random.uniform(5.0, 5.5))).quantize(Decimal('0.01'))
                    amount_brl = amount
                    amount_usd = (amount_brl / exchange_rate).quantize(Decimal('0.01'))
                    
                    # Entry 1: From BRL (-)
                    cur.execute(
                        "INSERT INTO entries (transaction_id, account_id, amount, currency, exchange_rate, amount_base) VALUES (%s, %s, %s, %s, %s, %s)",
                        (tx_id, account_ids[acc_from_key], -amount_brl, 'BRL', 1.0, -amount_brl)
                    )
                    # Entry 2: To USD (+)
                    cur.execute(
                        "INSERT INTO entries (transaction_id, account_id, amount, currency, exchange_rate, amount_base) VALUES (%s, %s, %s, %s, %s, %s)",
                        (tx_id, account_ids[acc_to_key], amount_usd, 'USD', exchange_rate, amount_brl)
                    )
                elif cur_from == 'USD' and cur_to == 'BRL':
                    exchange_rate = Decimal(str(random.uniform(5.0, 5.5))).quantize(Decimal('0.01'))
                    amount_usd = (amount / exchange_rate).quantize(Decimal('0.01'))
                    amount_brl = amount # amount here is BRL-ish in range 50-500
                    
                    # Entry 1: From USD (-)
                    cur.execute(
                        "INSERT INTO entries (transaction_id, account_id, amount, currency, exchange_rate, amount_base) VALUES (%s, %s, %s, %s, %s, %s)",
                        (tx_id, account_ids[acc_from_key], -amount_usd, 'USD', exchange_rate, -amount_brl)
                    )
                    # Entry 2: To BRL (+)
                    cur.execute(
                        "INSERT INTO entries (transaction_id, account_id, amount, currency, exchange_rate, amount_base) VALUES (%s, %s, %s, %s, %s, %s)",
                        (tx_id, account_ids[acc_to_key], amount_brl, 'BRL', 1.0, amount_brl)
                    )
                else:
                    # Fallback for unexpected combos
                    cur.execute(
                        "INSERT INTO entries (transaction_id, account_id, amount, currency, exchange_rate, amount_base) VALUES (%s, %s, %s, %s, %s, %s)",
                        (tx_id, account_ids[acc_from_key], -amount, cur_from, 1.0, -amount)
                    )
                    cur.execute(
                        "INSERT INTO entries (transaction_id, account_id, amount, currency, exchange_rate, amount_base) VALUES (%s, %s, %s, %s, %s, %s)",
                        (tx_id, account_ids[acc_to_key], amount, cur_to, 1.0, amount)
                    )

    conn.commit()
    print("Seed completed successfully.")
    cur.close()
    conn.close()

if __name__ == "__main__":
    seed()
